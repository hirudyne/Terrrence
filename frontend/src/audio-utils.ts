// Decode any browser audio blob and re-encode as 16-bit mono PCM WAV
export async function blobToWav(blob: Blob): Promise<ArrayBuffer> {
  const srcBuf = await blob.arrayBuffer()
  const audioCtx = new OfflineAudioContext(1, 1, 44100)
  const decoded = await audioCtx.decodeAudioData(srcBuf)
  const sampleRate = decoded.sampleRate
  const numSamples = decoded.length

  const offline = new OfflineAudioContext(1, numSamples, sampleRate)
  const src = offline.createBufferSource()
  src.buffer = decoded
  src.connect(offline.destination)
  src.start(0)
  const rendered = await offline.startRendering()
  const pcm = rendered.getChannelData(0)

  const byteCount = numSamples * 2
  const buf = new ArrayBuffer(44 + byteCount)
  const view = new DataView(buf)
  const wr = (off: number, val: number, size: number) => {
    if (size === 4) view.setUint32(off, val, true)
    else if (size === 2) view.setUint16(off, val, true)
    else view.setUint8(off, val)
  }
  const wrStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i))
  }
  wrStr(0, 'RIFF'); wr(4, 36 + byteCount, 4); wrStr(8, 'WAVE')
  wrStr(12, 'fmt '); wr(16, 16, 4); wr(20, 1, 2); wr(22, 1, 2)
  wr(24, sampleRate, 4); wr(28, sampleRate * 2, 4); wr(32, 2, 2); wr(34, 16, 2)
  wrStr(36, 'data'); wr(40, byteCount, 4)
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]))
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return buf
}

export function startRecording(): Promise<{ stop: () => Promise<Blob> }> {
  return navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')
      ? 'audio/ogg;codecs=opus'
      : ''
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
    const chunks: Blob[] = []
    recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data) }
    recorder.start()
    return {
      stop: () => new Promise<Blob>(resolve => {
        recorder.onstop = () => {
          stream.getTracks().forEach(t => t.stop())
          resolve(new Blob(chunks, { type: recorder.mimeType || 'audio/wav' }))
        }
        recorder.stop()
      })
    }
  })
}
