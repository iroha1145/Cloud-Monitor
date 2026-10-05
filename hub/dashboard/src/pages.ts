import { FileClock, Grid2X2, Layers3, Monitor, Wallet } from "lucide-react";

/** Every page, in navigation order; `short` labels the phone tab bar. */
export const PAGES = [
  {
    id: "overview",
    short: "总览",
    name: "总览",
    icon: Grid2X2,
  },
  {
    id: "models",
    short: "模型",
    name: "模型分析",
    icon: Layers3,
  },
  {
    id: "devices",
    short: "设备",
    name: "设备",
    icon: Monitor,
  },
  {
    id: "quota",
    short: "配额",
    name: "配额与订阅",
    icon: Wallet,
  },
  {
    id: "history",
    short: "历史",
    name: "历史记录",
    icon: FileClock,
  },
] as const;

export type PageId = (typeof PAGES)[number]["id"];
