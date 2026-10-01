/** How the bot decides when to respond; switched with /mode, starts as LISTEN_MODE. */
export const LISTEN_MODE_DESCRIPTIONS = {
  default: "always listening and responding",
  interrupt: "only responds after the wake word, goes quiet when idle or told",
} as const;

export type ListenMode = keyof typeof LISTEN_MODE_DESCRIPTIONS;

export const LISTEN_MODES = Object.keys(LISTEN_MODE_DESCRIPTIONS) as [ListenMode, ...ListenMode[]];

export function isListenMode(name: string): name is ListenMode {
  return Object.hasOwn(LISTEN_MODE_DESCRIPTIONS, name);
}
