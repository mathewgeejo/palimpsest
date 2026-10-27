const SAMPLE_RATE = 44_100;
const DURATION = 70;
const PEAK_TARGET = 0.88;

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function envelope(
  context: OfflineAudioContext,
  node: GainNode,
  start: number,
  end: number,
  attack: number,
  release: number,
  peak: number,
): void {
  const gain = node.gain;
  gain.setValueAtTime(0, start);
  gain.linearRampToValueAtTime(peak, start + attack);
  gain.setValueAtTime(peak, Math.max(start + attack, end - release));
  gain.linearRampToValueAtTime(0, end);
  void context;
}

function addPad(
  context: OfflineAudioContext,
  destination: AudioNode,
  frequency: number,
  start: number,
  end: number,
  level: number,
  type: OscillatorType = 'triangle',
  detune = 0,
): void {
  const oscillator = context.createOscillator();
  const voice = context.createGain();
  oscillator.type = type;
  oscillator.frequency.value = frequency;
  oscillator.detune.value = detune;
  envelope(context, voice, start, end, Math.min(2.2, (end - start) * 0.28), 2.1, level);
  oscillator.connect(voice).connect(destination);
  oscillator.start(start);
  oscillator.stop(end + 0.02);
}

function addKick(context: OfflineAudioContext, destination: AudioNode, time: number, level: number): void {
  const oscillator = context.createOscillator();
  const voice = context.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(112, time);
  oscillator.frequency.exponentialRampToValueAtTime(43, time + 0.17);
  voice.gain.setValueAtTime(0.0001, time);
  voice.gain.exponentialRampToValueAtTime(level, time + 0.008);
  voice.gain.exponentialRampToValueAtTime(0.0001, time + 0.29);
  oscillator.connect(voice).connect(destination);
  oscillator.start(time);
  oscillator.stop(time + 0.31);
}

function addPluck(
  context: OfflineAudioContext,
  destination: AudioNode,
  delayInput: AudioNode,
  frequency: number,
  time: number,
  level: number,
): void {
  const oscillator = context.createOscillator();
  const voice = context.createGain();
  oscillator.type = 'triangle';
  oscillator.frequency.value = frequency;
  voice.gain.setValueAtTime(0.0001, time);
  voice.gain.exponentialRampToValueAtTime(level, time + 0.009);
  voice.gain.exponentialRampToValueAtTime(0.0001, time + 0.42);
  oscillator.connect(voice);
  voice.connect(destination);
  voice.connect(delayInput);
  oscillator.start(time);
  oscillator.stop(time + 0.44);
}

function addNoiseBurst(
  context: OfflineAudioContext,
  destination: AudioNode,
  buffer: AudioBuffer,
  time: number,
  duration: number,
  level: number,
  filterType: BiquadFilterType,
  frequency: number,
): void {
  const source = context.createBufferSource();
  const filter = context.createBiquadFilter();
  const voice = context.createGain();
  source.buffer = buffer;
  filter.type = filterType;
  filter.frequency.value = frequency;
  filter.Q.value = filterType === 'bandpass' ? 0.8 : 0.7;
  voice.gain.setValueAtTime(0.0001, time);
  voice.gain.linearRampToValueAtTime(level, time + 0.003);
  voice.gain.exponentialRampToValueAtTime(0.0001, time + duration);
  source.connect(filter).connect(voice).connect(destination);
  source.start(time);
  source.stop(time + duration + 0.01);
}

function makeSection(
  context: OfflineAudioContext,
  destination: AudioNode,
  start: number,
  end: number,
  level: number,
  fadeIn = 1,
  fadeOut = 1,
): GainNode {
  const section = context.createGain();
  section.gain.setValueAtTime(0, start);
  section.gain.linearRampToValueAtTime(level, start + fadeIn);
  section.gain.setValueAtTime(level, end - fadeOut);
  section.gain.linearRampToValueAtTime(0, end);
  section.connect(destination);
  return section;
}

export async function renderDemo(): Promise<Blob> {
  const context = new OfflineAudioContext(2, SAMPLE_RATE * DURATION, SAMPLE_RATE);
  const master = context.createGain();
  master.gain.value = 0.78;
  master.connect(context.destination);
  const random = mulberry32(0x50414c49);

  const opening = makeSection(context, master, 0, 14, 0.42, 2.4, 2.2);
  addPad(context, opening, 73.42, 0.1, 14, 0.15, 'sine', -4);
  addPad(context, opening, 146.83, 0.5, 14, 0.095, 'triangle', 3);
  addPad(context, opening, 220, 4.3, 14, 0.06, 'sine', -2);
  addPad(context, opening, 293.66, 8.5, 14, 0.045, 'triangle', 4);

  const pulses = makeSection(context, master, 14, 48, 0.63, 1.3, 1.4);
  const drone = context.createOscillator();
  const droneVoice = context.createGain();
  drone.type = 'sine';
  drone.frequency.value = 55;
  droneVoice.gain.value = 0.14;
  drone.connect(droneVoice).connect(pulses);
  drone.start(14);
  drone.stop(48.1);
  addPad(context, pulses, 73.42, 14, 48, 0.055, 'triangle', -5);
  for (let time = 14; time < 48; time += 0.8) {
    addKick(context, pulses, time, 0.47);
  }

  const melody = makeSection(context, master, 30, 48, 0.66, 1.5, 1.3);
  const delay = context.createDelay(0.5);
  const feedback = context.createGain();
  const wet = context.createGain();
  delay.delayTime.value = 0.31;
  feedback.gain.value = 0.21;
  wet.gain.value = 0.25;
  delay.connect(feedback).connect(delay);
  delay.connect(wet).connect(melody);
  const notes = [587.33, 698.46, 783.99, 880, 1046.5, 1174.66, 1396.91, 1760];
  let noteTime = 30.1;
  let previousNote = 4;
  while (noteTime < 47.8) {
    const step = Math.floor(random() * notes.length);
    const index = Math.max(0, Math.min(notes.length - 1, previousNote + (step > 4 ? 1 : -1)));
    previousNote = random() < 0.66 ? index : step;
    addPluck(context, melody, delay, notes[previousNote]!, noteTime, 0.085 + random() * 0.035);
    noteTime += 0.42 + random() * 0.43;
  }

  const percussion = makeSection(context, master, 48, 60, 0.72, 0.7, 0.8);
  const noise = context.createBuffer(1, Math.ceil(SAMPLE_RATE * 0.24), SAMPLE_RATE);
  const noiseData = noise.getChannelData(0);
  for (let index = 0; index < noiseData.length; index += 1) {
    noiseData[index] = random() * 2 - 1;
  }
  for (let time = 48; time < 60; time += 0.3 + random() * 0.08) {
    addNoiseBurst(context, percussion, noise, time, 0.065, 0.14 + random() * 0.08, 'highpass', 6500);
    if (random() > 0.56) {
      addNoiseBurst(context, percussion, noise, time + 0.04, 0.13, 0.11 + random() * 0.07, 'bandpass', 1650);
    }
    if (random() > 0.62) {
      addKick(context, percussion, time, 0.19);
    }
  }

  const ending = makeSection(context, master, 60, 70, 0.32, 0.9, 2.5);
  addPad(context, ending, 146.83, 60.1, 70, 0.09, 'sine', 1);

  const rendered = await context.startRendering();
  let peak = 0;
  for (let channel = 0; channel < rendered.numberOfChannels; channel += 1) {
    const samples = rendered.getChannelData(channel);
    for (let index = 0; index < samples.length; index += 1) {
      peak = Math.max(peak, Math.abs(samples[index]!));
    }
  }
  const scale = peak > 0 ? PEAK_TARGET / peak : 1;
  const dataBytes = rendered.length * rendered.numberOfChannels * 2;
  const wav = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(wav);
  const writeText = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };
  writeText(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, rendered.numberOfChannels, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * rendered.numberOfChannels * 2, true);
  view.setUint16(32, rendered.numberOfChannels * 2, true);
  view.setUint16(34, 16, true);
  writeText(36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (let index = 0; index < rendered.length; index += 1) {
    for (let channel = 0; channel < rendered.numberOfChannels; channel += 1) {
      const sample = Math.max(-1, Math.min(1, rendered.getChannelData(channel)[index]! * scale));
      view.setInt16(offset, sample < 0 ? sample * 32768 : sample * 32767, true);
      offset += 2;
    }
  }
  return new Blob([wav], { type: 'audio/wav' });
}
