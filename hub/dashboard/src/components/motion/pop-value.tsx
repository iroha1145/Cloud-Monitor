import { useRef } from "react";

/**
 * transitions.dev 02 "number pop-in": when the value changes, each character
 * re-enters from below with a short blur, the last two digits a beat later.
 * The value it mounted with stays still, and the text content is exactly
 * `value`, so reading and copying the number are unaffected.
 */
export function PopValue({ value }: { value: string }) {
  const initial = useRef(value);
  const changed = useRef(false);
  if (value !== initial.current) changed.current = true;
  const chars = value.split("");
  const digits = chars.flatMap((char, index) => (/\d/.test(char) ? [index] : []));
  const stagger = new Map([
    [digits.at(-2), "1"],
    [digits.at(-1), "2"],
  ]);
  return (
    <span key={value} className={`t-digit-group${changed.current ? " is-animating" : ""}`}>
      {chars.map((char, index) => (
        <span key={index} className="t-digit" data-stagger={stagger.get(index)}>
          {char}
        </span>
      ))}
    </span>
  );
}
