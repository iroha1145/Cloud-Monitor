# Token Monitor v0.64.0 contract samples

The upload sample is a synthetic snapshot of the official v0.64.0 collector and sync serializer at commit `9ad1ca2f6ec27e497eb38fffe7d9533aec0d3c38`. It covers StepFun Coding Plan windows, Muse usage, reasoning-inclusive output for ZCode/OpenCode, canonical Cursor Auto models, Codex plan labels and client-source checks. It contains no credentials or local session titles.

Clock placeholders are replaced at test time. Expected values are committed separately and are never computed by the installed Cloud Monitor core.

The version-1 legacy store has Cursor Auto/default buckets alongside a Claude model also called default. Upgrading must merge only Cursor's share, preserve the 41-token total and avoid fabricating cache attribution for the mixed default bucket. Re-uploading the same cumulative record must not add it twice.
