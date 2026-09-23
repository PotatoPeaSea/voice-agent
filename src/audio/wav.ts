/** Wrap raw little-endian 16-bit PCM in a WAV container. */
export function pcmToWav(pcm: Buffer, sampleRate = 48_000, channels = 2): Buffer {
  const bytesPerSample = 2;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  header.writeUInt16LE(channels * bytesPerSample, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Duration in ms of 48kHz stereo s16le PCM. */
export function pcmDurationMs(pcm: Buffer, sampleRate = 48_000, channels = 2): number {
  return (pcm.length / (sampleRate * channels * 2)) * 1000;
}
