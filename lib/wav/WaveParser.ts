import * as strtok3 from 'strtok3';
import * as Token from 'token-types';
import initDebug from 'debug';

import * as riff from '../riff/RiffChunk.js';
import * as WaveChunk from './WaveChunk.js';
import { ID3v2Parser } from '../id3v2/ID3v2Parser.js';
import { FourCcToken } from '../common/FourCC.js';
import { BasicParser } from '../common/BasicParser.js';
import { MetadataCollector } from '../common/MetadataCollector.js';
import type { TagType } from '../common/GenericTagTypes.js';
import { BroadcastAudioExtensionChunk, type IBroadcastAudioExtensionChunk } from './BwfChunk.js';
import type { SupportedEncoding } from '@borewit/text-codec';
import { WaveContentError } from './WaveChunk.js';

const debug = initDebug('music-metadata:parser:RIFF');

/**
 * Resource Interchange File Format (RIFF) Parser
 *
 * WAVE PCM soundfile format
 *
 * Ref:
 * - http://www.johnloomis.org/cpe102/asgn/asgn1/riff.html
 * - http://soundfile.sapp.org/doc/WaveFormat
 *
 * ToDo: Split WAVE part from RIFF parser
 */
export class WaveParser extends BasicParser {

  // CSET applies to the whole file, including INFO chunks preceding it.
  private codePage: number | undefined;
  // Only defer tags behind INFO whose file-level encoding is still unknown.
  private readonly pendingMetadata: (() => Promise<void>)[] = [];

  private fact: WaveChunk.IFactChunk | undefined;
  private blockAlign = 0;
  private avgBytesPerSec = 0;
  private header: riff.IChunkHeader | undefined;

  public async parse(): Promise<void> {

    const riffHeader = await this.tokenizer.readToken<riff.IChunkHeader>(riff.Header);
    debug(`pos=${this.tokenizer.position}, parse: chunkID=${riffHeader.chunkID}`);
    if (riffHeader.chunkID !== 'RIFF')
      return; // Not RIFF format
    this.metadata.setAudioOnly();
    await this.parseRiffChunk(riffHeader.chunkSize).catch(err => {
      if (!(err instanceof strtok3.EndOfStreamError)) {
        throw err;
      }
    });
    await this.flushMetadata();
  }

  public async parseRiffChunk(chunkSize: number): Promise<void> {
    const type = await this.tokenizer.readToken<string>(FourCcToken);
    this.metadata.setFormat('container', type);
    switch (type) {
      case 'WAVE':
        return this.readWaveChunk(chunkSize - FourCcToken.len);
      default:
        throw new WaveContentError(`Unsupported RIFF format: RIFF/${type}`);
    }
  }

  public async readWaveChunk(remaining: number): Promise<void> {

    while (remaining >= riff.Header.len) {
      const header = await this.tokenizer.readToken<riff.IChunkHeader>(riff.Header);
      remaining -= riff.Header.len + header.chunkSize;
      if (header.chunkSize > remaining) {
        this.metadata.addWarning('Data chunk size exceeds file size');
      }

      this.header = header;
      debug(`pos=${this.tokenizer.position}, readChunk: chunkID=RIFF/WAVE/${header.chunkID}`);
      switch (header.chunkID) {

        case 'CSET': {
          if (header.chunkSize < 8) {
            throw new WaveContentError('CSET chunk must contain at least 8 bytes');
          }
          const codePage = await this.tokenizer.readToken(Token.UINT16_LE);
          await this.tokenizer.ignore(header.chunkSize - 2);
          this.codePage = codePage;
          if (!this.getInfoEncoding()) {
            this.metadata.addWarning(`Unsupported RIFF CSET code page: ${this.codePage}; LIST/INFO tags will be omitted`);
          }
          await this.flushMetadata();
          break;
        }

        case 'LIST':
          await this.parseListTag(header);
          break;

        case 'fact': // extended Format chunk,
          this.metadata.setFormat('lossless', false);
          this.fact = await this.tokenizer.readToken(new WaveChunk.FactChunk(header));
          break;

        case 'fmt ': { // The Util Chunk, non-PCM Formats
          const fmt = await this.tokenizer.readToken<WaveChunk.IWaveFormat>(new WaveChunk.Format(header));

          let subFormat = WaveChunk.WaveFormatNameMap[fmt.wFormatTag];
          if (!subFormat) {
            debug(`WAVE/non-PCM format=${fmt.wFormatTag}`);
            subFormat = `non-PCM (${fmt.wFormatTag})`;
          }
          this.metadata.setFormat('codec', subFormat);
          this.metadata.setFormat('bitsPerSample', fmt.wBitsPerSample);
          this.metadata.setFormat('sampleRate', fmt.nSamplesPerSec);
          this.metadata.setFormat('numberOfChannels', fmt.nChannels);
          this.blockAlign = fmt.nBlockAlign;
          this.avgBytesPerSec = fmt.nAvgBytesPerSec;
          break;
        }

        case 'id3 ': // The way Picard, FooBar currently stores, ID3 meta-data
        case 'ID3 ': { // The way Mp3Tags stores ID3 meta-data
          const id3_data = await this.tokenizer.readToken<Uint8Array>(new Token.Uint8ArrayType(header.chunkSize));
          const rst = strtok3.fromBuffer(id3_data);
          if (this.pendingMetadata.length === 0) {
            await new ID3v2Parser().parse(this.metadata, rst, this.options);
          } else {
            // Validate ID3 now; only its metadata effects depend on earlier INFO.
            const staged = new MetadataCollector();
            staged.addTag = async (type, id, value) => {
              (staged.native[type] ??= []).push({id, value});
            };
            await new ID3v2Parser().parse(staged, rst, this.options);
            await this.addMetadata(async () => {
              for (const [type, tags] of Object.entries(staged.native)) {
                for (const tag of tags) {
                  await this.metadata.addTag(type as TagType, tag.id, tag.value);
                }
              }
              for (const warning of staged.quality.warnings) {
                this.metadata.addWarning(warning.message);
              }
              this.metadata.setFormat('chapters', staged.format.chapters);
            });
          }
          break;
        }

        case 'data': { // PCM-data
          if (this.metadata.format.lossless !== false) {
            this.metadata.setFormat('lossless', true);
          }

          let chunkSize = header.chunkSize;
          if (this.tokenizer.fileInfo.size) {
            const calcRemaining = this.tokenizer.fileInfo.size - this.tokenizer.position;
            if (calcRemaining < chunkSize) {
              this.metadata.addWarning('data chunk length exceeding file length');
              chunkSize = calcRemaining;
            }
          }

          const numberOfSamples = this.fact ? this.fact.dwSampleLength : (chunkSize === 0xffffffff ? undefined : chunkSize / this.blockAlign);
          if (numberOfSamples) {
            this.metadata.setFormat('numberOfSamples', numberOfSamples);
            if (this.metadata.format.sampleRate) {
              this.metadata.setFormat('duration', numberOfSamples / this.metadata.format.sampleRate);
            }
          }

          if (this.avgBytesPerSec > 0) {
            this.metadata.setFormat('bitrate', this.avgBytesPerSec * 8);
          } else if (this.metadata.format.duration) {
            this.metadata.setFormat('bitrate', chunkSize * 8 / this.metadata.format.duration);
          }
          await this.tokenizer.ignore(header.chunkSize);
          break;
        }

        case 'bext': { // Broadcast Audio Extension chunk	https://tech.ebu.ch/docs/tech/tech3285.pdf
          const bext = await this.tokenizer.readToken(BroadcastAudioExtensionChunk);
          for (const key of Object.keys(bext)) {
            await this.addMetadata(() => this.metadata.addTag('exif', `bext.${key}`, bext[key as keyof IBroadcastAudioExtensionChunk]));
          }
          const bextRemaining = header.chunkSize - BroadcastAudioExtensionChunk.len;
          await this.tokenizer.ignore(bextRemaining);
          break;
        }

        case '\x00\x00\x00\x00': // padding ??
          debug(`Ignore padding chunk: RIFF/${header.chunkID} of ${header.chunkSize} bytes`);
          this.metadata.addWarning(`Ignore chunk: RIFF/${header.chunkID}`);
          await this.tokenizer.ignore(header.chunkSize);
          break;

        default:
          debug(`Ignore chunk: RIFF/${header.chunkID} of ${header.chunkSize} bytes`);
          this.metadata.addWarning(`Ignore chunk: RIFF/${header.chunkID}`);
          await this.tokenizer.ignore(header.chunkSize);
      }

      if ((this.header as riff.IChunkHeader).chunkSize % 2 === 1) {
        debug('Read odd padding byte'); // https://wiki.multimedia.cx/index.php/RIFF
        await this.tokenizer.ignore(1);
      }
    }
  }

  public async parseListTag(listHeader: riff.IChunkHeader): Promise<void> {
    const listType = await this.tokenizer.readToken(new Token.StringType(4, 'latin1'));
    debug('pos=%s, parseListTag: chunkID=RIFF/WAVE/LIST/%s', this.tokenizer.position, listType);
    switch (listType) {
      case 'INFO':
        return this.parseRiffInfoTags(listHeader.chunkSize - 4);
      default:
        this.metadata.addWarning(`Ignore chunk: RIFF/WAVE/LIST/${listType}`);
        debug(`Ignoring chunkID=RIFF/WAVE/LIST/${listType}`);
        return this.tokenizer.ignore(listHeader.chunkSize - 4).then();
    }
  }

  private async parseRiffInfoTags(chunkSize: number): Promise<void> {
    while (chunkSize >= 8) {
      const header = await this.tokenizer.readToken<riff.IChunkHeader>(riff.Header);
      const valueToken = new riff.ListInfoTagValue(header);
      const bytes = await this.tokenizer.readToken(new Token.Uint8ArrayType(valueToken.len));
      await this.addMetadata(async () => {
        const encoding = this.getInfoEncoding();
        if (encoding) {
          const value = new riff.ListInfoTagValue(header, encoding).get(bytes, 0);
          await this.metadata.addTag('exif', header.chunkID, value);
        }
      }, true);
      chunkSize -= (8 + valueToken.len);
    }

    if (chunkSize !== 0) {
      throw new WaveContentError(`Illegal remaining size: ${chunkSize}`);
    }
  }

  private async addMetadata(add: () => Promise<void>, needsEncoding = false): Promise<void> {
    if (this.pendingMetadata.length > 0 || (needsEncoding && this.codePage === undefined)) {
      this.pendingMetadata.push(add);
    } else {
      await add();
    }
  }

  private async flushMetadata(): Promise<void> {
    for (const add of this.pendingMetadata.splice(0)) {
      await add();
    }
  }

  private getInfoEncoding(): SupportedEncoding | undefined {
    // RIFF CSET: absent/zero means ISO 8859-1, not Windows-1252.
    // https://www.robotplanet.dk/audio/wav_meta_data/riff_mci.pdf#page=25
    switch (this.codePage) {
      case undefined:
      case 0:
      case 28591:
        return 'latin1';
      case 1252:
        return 'windows-1252';
      case 65001:
        return 'utf-8';
      default:
        return undefined;
    }
  }

}
