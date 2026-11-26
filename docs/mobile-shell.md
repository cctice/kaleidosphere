# 移动端壳（第一步：iOS 快捷指令壳）

> 维护心跳包·九轮：`ks route` 的单短命令形态早已为快捷键/移动端壳复用同一入口留了锚，
> 但壳本体零进展。本页落纸第一步——不写原生 App，用 iOS 快捷指令（Shortcuts）+
> 「Run script over SSH」直接复用 route 入口，移动端"下一块玻璃转哪儿"一条指令可达。

## 前置

- iPhone 安装 Shortcuts（系统自带）。
- Mac 与手机同一 Tailscale 网络（本仓生态既有信任模型：oneoffice 网关同样跑在 Tailscale 上）。
- Mac 开启远程登录（系统设置 → 通用 → 共享 → 远程登录）。
- `ks` 可执行：`node /path/to/kaleidosphere/cli/ks.js`（可先 `npm link` 或做个别名脚本）。

## 壳配方（跟着做，5 步）

1. 新建快捷指令，添加动作 **Run Script Over SSH**。
2. 填主机（Mac 的 Tailscale 主机名或 IP）、用户、认证方式（密码或密钥）。
3. 脚本一行：

   ```sh
   node /path/to/kaleidosphere/cli/ks.js route --shell
   ```

4. 添加动作 **Show Result**（或 **Quick Look**）：上一步输出即 `项目名<TAB>项目路径` 单行，
   副作用与桌面端 `ks route` 完全同源——转动记录照常落 `state/rotation.json`，
   桌面端的 ks status 停转提醒看得见移动端转过的那一轮。
5. 建议再加一个快捷指令（灵感捕获反向通道）：

   ```sh
   node /path/to/kaleidosphere/cli/ks.js spark capture --source im --title "$(Ask for Input)" --text "$(Ask for Input)" --json
   ```

   手机上想到的事一条指令进 spark 库，回桌面 `ks spark list` 可见（source: im 回溯）。
   要顺手打标签（二十四轮起与 `create --tag` 同款）：`--tag 网络 --tag 代理`（可多次，
   回桌面 `ks spark list --tag 网络` 直接收窄）。

## 为什么这是"同一入口"而不是平行系统

- `--shell` 只是输出形态（单行 `name<TAB>path`，机器可读），选择算法、rotation 状态、
  withStateLock 并发保护全部与桌面 route 共用——移动端转一轮，桌面端状态同步前进。
- 快捷指令可绑到锁屏/操作按钮（Action Button）：长按即得"下一块玻璃"。

## 边界（如实）

- 本页是壳的第一步（快捷指令形态），不是原生 App：离线、通知、widget 是后续题。
- SSH 出网依赖 Tailscale 在场；Tailscale 不在则快捷指令如实失败（不假绿）。

## 离线能力（第二步：缓存计划 + 离线队列重放）

> 维护心跳包·十二轮：第一步的壳在线依赖 SSH——断网零能力。第二步把断网场景
> 拆成读面（下一块玻璃去哪）与写面（断网时想到的火花）分别落地，全部复用
> 桌面端同一状态面，不另起平行系统。

### 读面：缓存计划（`ks route --plan`）

route 的选择是确定性排序（least-recently-routed + createdAt 决胜），所以未来
几步**离线可算**：

```sh
node /path/to/kaleidosphere/cli/ks.js route --plan 5 --json
# 或壳机面：route --plan 5 --shell  → 每行 name<TAB>path，按未来转动顺序
```

快捷指令配方：

1. 新建「KS 同步」快捷指令：Run Script Over SSH 跑上面命令 → **Set Variable**
   `KS_ROUTE_PLAN`（快捷指令变量存在手机本地，断网可读）。
2. 新建「下一块玻璃（离线）」快捷指令：Get Variable `KS_ROUTE_PLAN` → 显示
   前 2-3 项 + `generatedAt`（"缓存于 N 小时前"）。绑 Action Button——断网时
   长按也有答案，Mac 不在场也不白屏。
3. `--plan` 是只读预演：rotation.json 分毫不动；桌面端离线期间真转过则计划
   过期——`generatedAt` 如实展示，不冒充实时。重新联网跑一次「KS 同步」即刷新。
4. 缓存新鲜度不用人算（十三轮）：联网后跑一次 `ks route --plan --status`——
   `verdict: fresh | stale | mismatch` 三态真话（age 超阈值=stale；桌面真转过
   planId 不匹配=mismatch），`hint` 直接给下一步；阈值 `KS_PLAN_STALE_HOURS`
   （默认 24，0=关闭 age 判定，内容口径 planId 仍看守）。显示缓存前先问一次。

### 写面：离线队列重放（`ks spark capture --batch`）

断网时想到的火花先进快捷指令本地队列（Dictionary 累加），联网后一次回放：

1. 新建「KS 采火花（离线安全）」快捷指令：Ask for Input（标题、正文）→
   Append to Dictionary 存进本地队列（不触网，立即成功）。
2. 新建「KS 回放队列」快捷指令：取队列 → **Get Contents of JSON** 组装成
   `[{title, text, source?, tags?}]` 数组 → Base64/文件传给 Mac → Run Script Over SSH：

   ```sh
   node /path/to/kaleidosphere/cli/ks.js spark capture --batch /tmp/ks-queue.json --source im --json
   ```

3. 回放幂等：已存在（上次回放到一半断线）按 slug 跳过不报错，报告里
   `created/skipped-exists/failed` 三态逐条可见；单条坏不连坐；队列文件
   本身不认则零写入整批拒绝。成功后清空本地队列。
4. 失败留痕不用回放方记账（十三轮）：失败条目自动落 Mac 侧
   `state/replay-todo.json`（title/error/原始条目随行，封顶 500），下次重放
   成功即销账；随时 `ks spark capture --show-todo` 回看待办。

### 边界（如实·第二步后）

- 离线读面 = 缓存计划（只读预测）：桌面端离线期间转动过则计划过期，以
  `generatedAt` 为准；不是实时状态。
- 离线写面 = 延迟重放：火花不是实时入库，回到桌面 `ks spark list` 可见
  （source 随行回溯）。
- 通知、widget 定时刷新仍是后续题（需要原生/半原生壳，本仓 CLI 面不吹成完成）。
