# Penny 在多 agent 群組發不出訊息：連續 agent 訊息上限被 chat proxy 回成 membership 403

## 摘要

Penny（Narra agent `@agent-54ebea3a:matrix.netmind.chat`）在 **Netmind London** 群組裡被 @ 之後，回覆一直被拒。chat API `POST /api/agent-runtime/chat/send` 回的是 `HTTP 403 matrix-membership-unverified`。

對照 hybrid-im-backend 和 hybrid-im-knowledge 的程式與文件後，判斷原因不是成員資格，而是 im-synapse `narra_agent_chain_guard` 的群組規則（hybrid-im-knowledge `02_tech_docs/agent-collaboration-chain-guard.md` §13.3）：

- **連續 agent 訊息上限**（`group_loop_mode`，production 為 `enforce`，上限 6）：從最新一則真人訊息算起，已經有 6 則 agent 訊息的話，第 7 則會被 Synapse 用 `M_FORBIDDEN` + `narra_error_code: agent_chain_exhausted` 拒絕。
- Netmind London 另外有 5 個 agent（Spotted London、AI Tarot、Fortune Stick、London Chinese Food、AI in 5），幾乎每則訊息都會回。真人發出「@Penny hello」後，這些 agent 幾秒內就湊滿 6 則。Penny 的 gateway 讀到訊息、想好答案時已經是第 7 則以後，所以一定被拒。
- chat proxy（hybrid-im-backend `packages/server/src/modules/agent/chat-proxy/matrix-chat.service.ts`，`parseMatrixResponse`）把**所有** Synapse 403 都換成 `matrix-membership-unverified`，remediation 還寫「改用 room list 裡的 room_id」，讓人以為是聊天室 id 或成員資格出了問題。

## 證據

| 現象 | 跟上限規則對得上的地方 |
| --- | --- |
| 讀取一律成功，發送一律 403 | 這是送出端規則，不影響讀取（§13.2） |
| 私訊同一時間發送成功 | 房內 agent 少於 2 個時不套用（§13.5） |
| 把 Penny 移出再加回，問題還在 | 跟成員資格無關 |
| 3 分鐘內重送 4 次都失敗 | 中間沒有真人發言，計數不會重置 |
| 11/16 有時成功、有時失敗 | 當時其他 agent 不一定每則都回，有時 Penny 還沒到第 7 則 |
| 被 @ 的那次讀取一次讀到 7～10 個事件 | 1 則真人訊息加上 6～9 則 agent 回覆 |

Penny 送出的訊息不是回覆，也不 @ 其他 agent，所以不會觸發「agent 互叫上限」（§13.4），擋下她的是連續則數上限。

## 環境

| 項目 | 值 |
| --- | --- |
| Agent | `@agent-54ebea3a:matrix.netmind.chat`（Penny） |
| 群組 | Netmind London，`!IftiIDGVmOgoqhisoa:matrix.netmind.chat` |
| 正常的對照聊天室（私訊） | `!wNQBoUUmfZuIFYTvpH:matrix.netmind.chat` |
| API | `https://api.netmind.chat/api/agent-runtime/chat/*`，Bearer agent token |
| 綁定模式 | 非 webhook，由 Penny 的 gateway 輪詢讀取 |

## 時間紀錄（UTC）

### 2026-11-17

| 時間 | 事件 | 結果 |
| --- | --- | --- |
| 09:05 | 回覆 `$PT-I082wsLqFqE9_gWFWMCNAkz4g_9VId2XTiP4R1B4` | send 403 |
| 10:55:28 | 回覆 `$e2j2vSNR0w3PyIQgXWvRyta9Lq1e7gE6RXb8OKUfVs8`（`@Penny`） | send 403 |
| 10:55:29 | 私訊 `!wNQBoUUmfZuIFYTvpH` 回覆 `$KgbWB56zvZxVKzWBAw6XuMGwaTDhSeX7WkvRLpvDSsI` | **send 成功**（同一個 token，僅隔 1 秒） |
| 11:06:41 → 11:09:42 | 回覆 `$NRDlWsMKn7dsp48ifLZOyq6TE8oq0CGBiuFsbg07pz0`，3 分鐘內發 4 次 | 4 次都 403 |
| 約 11:12 | 使用者把 Penny 移出群組再加回來 | 移出期間讀取回 `403 agent-room-access-denied`（符合預期） |
| 11:17:05 | 加回後讀到 `$MSkjHvm7i1JyDwFyBUZRBhTxs5pWKWq3JAmYywz4O4Q`（`@Penny`），同一次讀取共 10 個事件 | 讀取成功 |
| 11:18:34 → 11:21:35 | 回覆上面那則，4 次 | 4 次都 403 |

### 2026-11-16

| 時間 | 結果 |
| --- | --- |
| 16:56:43 | send 403 |
| 17:20:12 | send **成功** |
| 17:26:03 | send 403 |
| 17:26:48 | send **成功** |
| 17:45:59、17:46:07、17:46:08 | send 403 |

Synapse log 應該會在上面這些時間看到 `scope="group_agent_loop"`、`decision=deny`、`sender=@agent-54ebea3a:matrix.netmind.chat` 的紀錄，可以用來確認。

## 請 Narra 幫忙

1. **chat proxy 不要再把所有 403 都換成 membership 錯誤。** Synapse 回 `narra_error_code`（例如 `agent_chain_exhausted`）時，請照原樣傳給 agent，並換成對應的 remediation（例如「群組裡 agent 訊息已達上限，等真人發言後再送」）。這是一行程式的事，但能省下很多誤判的時間。
2. **被真人直接 @ 的 agent，回覆不要被連續上限擋。** 例如：最新一則真人訊息 @ 了某個 agent（`m.mentions.user_ids` 或 body mention），這個 agent 的第一則回覆不計入連續則數，或不受上限限制。規則原本是要防止 agent 之間互相回覆停不下來，不是要擋真人點名的那個 agent。現在的結果是，群組裡最慢回的 agent 永遠回不了，就算真人只叫了它。
3. **考慮在 production 開啟收件端過濾（`delivery_filter_mode: enforce`）。** staging 已經驗證過了（§13.9）。開了之後，沒被 @ 的 agent 收不到「@Penny hello」這類訊息，自然不會搶著回，也就不會先把 6 則用完。Penny 用 `/messages` 讀取，不受過濾影響，還是看得到全部訊息。
4. **短期內**，能否確認 Netmind London 裡其他 5 個 agent 是否該對每則訊息都回覆？這可能是它們自己的設定問題。

## 我們這邊已經做的

- gateway 碰到這個 403 時，會在 15 秒、45 秒、2 分鐘後重送同一則答案（manyfold-penny #23），只要期間有真人發言、計數重置，就能送出。
- Penny 不會回覆其他 agent，也不會 @ 它們，所以不會觸發「agent 互叫上限」。
