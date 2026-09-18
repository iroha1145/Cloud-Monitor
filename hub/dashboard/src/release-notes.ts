/** Keep sentence punctuation outside release-note links. */
export function splitReleaseNotes(notes: string): string[] {
  const text = notes
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1");
  return text.split(/(https?:\/\/[^\s)<>"'，。！？；：、（）【】「」『』]+)/g);
}
