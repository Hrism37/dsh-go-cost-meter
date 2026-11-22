# dsh-go-cost-meter

**DSHGo（dsh-go 手机 App）原生费用插件** —— 仿 [dsh-cost-meter](https://github.com/han-1413141/dsh-cost-meter) 的费用显示，但只在 **dsh-go 的原生界面**里显示，不往 Harness 网页端注入任何东西。

> 包名：`local-cost-meter` · 版本：`0.3.0` · 依赖宿主已安装的 `dsh-cost-meter` 作为数据源

## 功能

| 位置 | 内容 |
|---|---|
| 输入框上方「费用」胶囊（与「插件」并排） | 点一下打开费用面板 |
| 每条回复下方 | 本轮费用（`¥0.0123`），与网页端 **同一算法**：按轮的日志区间重放计价，含该轮的搜索/抓取请求费，不含子代理与继承历史 |
| 费用面板（胶囊 / 对话详情「插件」页签 / 全部功能） | 本会话、今日、近 7 天费用；7 日柱状图；本会话 Token 构成与缓存命中率；模型费用排行；峰谷倒计时与下次切换；预算进度（启用预算时）；计价口径说明与「同步官方人民币价」按钮 |

## 计价：DeepSeek 官方人民币价

- 首次运行会把 dsh-cost-meter 的「官方价格币种」切成 **人民币**，并同步 DeepSeek 官方中文价格页（只做一次）。
- 之后直接按官方 ¥ 单价折算，不再依赖「美元价 × 汇率」往返换算。
- 参考价（每百万 token，2026-11 官方页）：`deepseek-flash` 缓存命中 ¥0.02、未命中 ¥1、输出 ¥4，峰时 ×2。
- 面板底部显示当前计价口径；可随时点「同步官方人民币价」重新同步。
- 币种、小数位、计费口径（API / Plan / 合计）、峰谷时段与假期、预算设置全部沿用 dsh-cost-meter 的配置。

## 依赖

1. **dsh-cost-meter**（必须，数据源）：`dsh plugin --profile web add dsh-cost-meter`
2. **DSH** `0.2.1-rc.2` ~ `0.3.0`（在 `0.2.2-rc.1` 上验证）
3. **dsh-go App**（手机原生界面；本机引擎自带桥接）

## 安装

```sh
# 1) 放到 dsh-go 插件目录
git clone https://github.com/Hrism37/dsh-go-cost-meter.git \
  "$DSH_HOME/dsh-go/plugins/dsh-go-cost-meter"

# 2) 装进当前 profile（装的是指向该目录的链接，目录不能删）
dsh plugin --profile web add "$DSH_HOME/dsh-go/plugins/dsh-go-cost-meter"

# 3) App：设置 → 引擎 → 重启（加载新插件）
```

装好后：输入框上方出现「费用」胶囊，每条回复下方出现本轮费用，点胶囊打开费用面板。

### 卸载

```sh
dsh plugin --profile web remove local-cost-meter
rm -rf "$DSH_HOME/dsh-go/plugins/dsh-go-cost-meter"
```

## 实现要点

- `package.json` 的 `dshGo` 清单声明原生界面（`composer.actions` 胶囊、`turn.note` 回合脚注、`panels` 面板）；App 只画声明和 JSON 视图，不执行插件代码。
- `lib/index.js` 在引擎里运行：
  - 回合脚注：读取会话日志中每轮 `turn/start` 与 `turn/end` 的 seq，逐轮调用 `costMeter.getTurnCost(sessionId, startSeq, endSeq)`（与网页端 turnTail 同一函数），结果按会话缓存、`turn/end` 时失效。
  - 面板：`getBillingStatistics` / `getSessionBilling`，服务不可用时回退读 `$DSH_HOME/storages/cost-meter/ledger.json`。
  - 金额展示：与网页端 `displayCostOf + formatMoneyUsd` 同口径（优先冻结的 `costCny`，否则按 `fxRates.CNY` 折算）。
  - 计价切换：`costMeter.updateConfig({ pricingCurrency: 'CNY' })` + `costMeter.fetchPrices()`，成功后写标记文件，之后不再自动切换。

## 说明与限制

- 只画原生界面，不含 dsh-cost-meter 的订阅额度 / 余额 / 导出等功能（那些在网页端）。
- 费用为按账本与调用日志的**估算**；缓存读/写按模型命中价计，峰/谷按 dsh-cost-meter 的规则切换。
- 切换官方人民币价会同时影响网页端显示的计价口径（两者共用同一份账本与价格表），这是计价设置而非 UI 改动。

## License

MIT
