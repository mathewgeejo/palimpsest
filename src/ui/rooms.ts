import type { VisualMode } from '../types';

export interface RoomInfo {
  mode: VisualMode;
  numeral: string;
  title: string;
  /** Wall-label "medium" line. */
  medium: string;
  /** What the listener is looking at, in one or two sentences. */
  note: string;
}

export const ROOMS: readonly RoomInfo[] = [
  {
    mode: 'membrane',
    numeral: 'I',
    title: 'Membrane',
    medium: 'Translucent sheet, 24 rows a second',
    note: 'The present is a bright, flexing lip. Everything already heard stays behind it as dim, folded strata.',
  },
  {
    mode: 'rupture',
    numeral: 'II',
    title: 'Rupture',
    medium: 'Feedback painting, kaleidoscope',
    note: 'Each frame is smeared and torn into the next. Every onset snaps the mirror to a new symmetry.',
  },
  {
    mode: 'splat',
    numeral: 'III',
    title: 'Splat',
    medium: 'Anisotropic Gaussians, depth of field',
    note: 'A wandering light sheds soft ellipsoids: embers for bass, twin petal strands for the mids, needles for treble. Their colour shifts with the angle you see them from.',
  },
  {
    mode: 'suminagashi',
    numeral: 'IV',
    title: 'Suminagashi',
    medium: 'Floating ink, exact marbling',
    note: 'Ink and water fall one after the other, and every drop pushes all the earlier ink outward. Loudness sets how wide each ring is. Bass drags a comb through it.',
  },
  {
    mode: 'morphogen',
    numeral: 'V',
    title: 'Morphogen',
    medium: 'Gray–Scott reaction–diffusion',
    note: 'Two chemicals feed on each other and grow. Timbre picks the species, onsets seed new colonies and treble sets off spores.',
  },
  {
    mode: 'phosphor',
    numeral: 'VI',
    title: 'Phosphor',
    medium: 'Delay embedding on a two-phosphor screen',
    note: 'The waveform is plotted against its own past, in three dimensions. A pure tone closes into a loop, a chord winds into a torus and noise spreads into a cloud.',
  },
  {
    mode: 'chladni',
    numeral: 'VII',
    title: 'Chladni',
    medium: 'Standing waves, three sands',
    note: 'A metal plate vibrates in the shapes of the spectrum. Each band has its own sand, which settles where the plate stays still.',
  },
];

export const ROOM_ORDER: readonly VisualMode[] = ROOMS.map((room) => room.mode);

export function roomInfo(mode: VisualMode): RoomInfo {
  return ROOMS.find((room) => room.mode === mode) ?? ROOMS[0]!;
}
