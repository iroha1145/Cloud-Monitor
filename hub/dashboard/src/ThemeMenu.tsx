import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Monitor, Moon, Settings2, Sun } from "lucide-react";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel } from "./components/ui/select";
import type { ThemePreference } from "./lib/theme";

const choices = [
  { value: "system", label: "跟随系统", icon: Monitor },
  { value: "light", label: "浅色", icon: Sun },
  { value: "dark", label: "深色", icon: Moon },
] as const;

export function ThemeMenu({ preference, onChoose }: {
  preference: ThemePreference;
  onChoose: (preference: ThemePreference, origin: HTMLElement | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <Select value={preference} open={open} onOpenChange={setOpen} onValueChange={value => {
      // Close the menu before capturing the old page for the circular reveal.
      flushSync(() => setOpen(false));
      onChoose(value as ThemePreference, trigger.current);
    }}>
      <SelectPrimitive.Trigger ref={trigger} className="icon-button theme-menu-trigger" aria-label="外观设置" title="外观设置">
        <Settings2 size={17} aria-hidden="true" />
      </SelectPrimitive.Trigger>
      {open && <SelectContent align="end" className="theme-menu">
        <SelectGroup>
          <SelectLabel>外观</SelectLabel>
          {choices.map(({ value, label, icon: Icon }) => (
            <SelectItem key={value} value={value}>
              <Icon size={16} aria-hidden="true" />{label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>}
    </Select>
  );
}
