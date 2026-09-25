/**
 * PCM helpers. All buffers are signed 16-bit little-endian.
 * Discord format: 48kHz stereo. STT input format: 16kHz mono.
 */

export const DISCORD_RATE = 48_000;
export const STT_RATE = 16_000;

/** 48kHz stereo -> 16kHz mono: average channels, then average each group of 3 samples. */
export function discordToStt(pcm: Buffer): Buffer {
  const frames = Math.floor(pcm.length / 4);
  const outSamples = Math.floor(frames / 3);
  const out = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    let sum = 0;
    for (let j = 0; j < 3; j++) {
      const offset = (i * 3 + j) * 4;
      sum += pcm.readInt16LE(offset) + pcm.readInt16LE(offset + 2);
    }
    out.writeInt16LE(Math.round(sum / 6), i * 2);
  }
  return out;
}

/** Mono -> stereo by duplicating each sample. */
export function monoToStereo(pcm: Buffer): Buffer {
  const samples = Math.floor(pcm.length / 2);
  const out = Buffer.alloc(samples * 4);
  for (let i = 0; i < samples; i++) {
    const s = pcm.readInt16LE(i * 2);
    out.writeInt16LE(s, i * 4);
    out.writeInt16LE(s, i * 4 + 2);
  }
  return out;
}

/** Linear-interpolation resample of mono PCM (for providers that can't output 48kHz). */
export function resampleMono(pcm: Buffer, fromRate: number, toRate: number): Buffer {
  if (fromRate === toRate) return pcm;
  const inSamples = Math.floor(pcm.length / 2);
  const outSamples = Math.floor((inSamples * toRate) / fromRate);
  const out = Buffer.alloc(outSamples * 2);
  const ratio = fromRate / toRate;
  for (let i = 0; i < outSamples; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = pcm.readInt16LE(Math.min(idx, inSamples - 1) * 2);
    const b = pcm.readInt16LE(Math.min(idx + 1, inSamples - 1) * 2);
    out.writeInt16LE(Math.round(a + (b - a) * frac), i * 2);
  }
  return out;
}

/** Silence of the given duration in 16kHz mono. */
export function sttSilence(ms: number): Buffer {
  return Buffer.alloc(Math.round((STT_RATE * ms) / 1000) * 2);
}

/**
 * Buffers odd-sized byte chunks so consumers only ever see whole samples.
 * Needed when base64 audio chunks split a 16-bit sample across messages.
 */
export class SampleAligner {
  private carry: Buffer = Buffer.alloc(0);
  constructor(private readonly bytesPerFrame: number) {}

  push(chunk: Buffer): Buffer {
    const data = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk;
    const usable = data.length - (data.length % this.bytesPerFrame);
    this.carry = data.subarray(usable);
    return data.subarray(0, usable);
  }
}
