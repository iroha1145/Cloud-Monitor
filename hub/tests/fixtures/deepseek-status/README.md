DeepSeek 官方状态页 Atom feed 样本，供 `tests/test_provider_status.py` 使用。

- `recorded-2026-11-06.atom`：2026-11-06 从 https://status.deepseek.com/feed.atom 原样录下，25 条事件全部 resolved。
- 其余文件都从这份录像派生：feed 头、条目结构、转义方式与录像一致，只改了状态行、正文和时间。
  - `active-outage.atom`：最新一条「网页/API 部分中断」改成 monitoring。
  - `degraded.atom`：「API 性能下降」（只影响 V4 Pro API）改成 investigating，并放到最新。
  - `chat-only.atom`：「网页部分中断」（只影响对话服务）改成 identified，并放到最新。
  - `maintenance-only.atom`：按官方条目格式补一条进行中的计划维护，后面是已解决的历史。
  - `empty.atom`：feed 头完整、闭合，但没有任何条目。

截断与不完整的样本在测试里由录像现场截出，不单独存文件。
