import { FileClock, Grid2X2, Layers3, Monitor, Wallet } from "lucide-react";

/** Every page, in navigation order; `short` labels the phone tab bar. */
export const PAGES = [
  {
    id: "overview",
    short: "总览",
    name: "总览",
    icon: Grid2X2,
    description: "所有用量，汇聚一处。",
  },
  {
    id: "models",
    short: "模型",
    name: "模型分析",
    icon: Layers3,
    description: "找到最适合你的模型，理解每一份用量。",
  },
  {
    id: "devices",
    short: "设备",
    name: "设备",
    icon: Monitor,
    description: "随时了解各台设备的用量与同步状态。",
  },
  {
    id: "quota",
    short: "配额",
    name: "配额与订阅",
    icon: Wallet,
    description: "额度还有多少，下一次何时续费。",
  },
  {
    id: "history",
    short: "历史",
    name: "历史记录",
    icon: FileClock,
    description: "把每一次使用，放回时间里。",
  },
] as const;

export type PageId = (typeof PAGES)[number]["id"];
