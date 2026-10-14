# 后台插件

这是 SHP 管理后台的扩展机制，与原游戏插件无关。插件读取管理后台提供的采样结果，不修改游戏。

## 安装与启用

1. 将插件放到 `plugins/<id>/`（可用 `PLUGINS_DIR` 更改目录）。
2. 在“插件管理”点击“重新扫描”，清单错误会在页面显示。
3. 每个插件默认有一个实例（停用状态）。点“启用”运行它，点“设置”改它的参数；运行状态和设置保存到 `data/plugins.json`，重启后恢复。
4. 需要把同一个插件用到多个服务时，点“添加实例”新建一个实例，绑定到不同服务并单独设置、单独启停（每个插件至少保留一个实例）。
5. 更新插件前先停用，替换文件后重新扫描，再启用。删除插件目录后扫描即可移除列表项。

默认附带 `resource-alerts`（阈值检查）与 `stronghold-updater`（每天定时更新 Stronghold-Protocol：`git pull` 或下载官方增量更新包）两个示例插件。插件安装通过本地文件完成，不提供浏览器上传任意可执行代码或远程下载市场。

## 清单

文件：`plugins/example/plugin.json`：

```json
{
  "id": "example",
  "name": "我的监控插件",
  "version": "1.0.0",
  "apiVersion": 1,
  "description": "展示自定义监控结果",
  "entry": "index.mjs",
  "settings": [
    { "key": "threshold", "type": "number", "label": "阈值 (%)", "default": 90, "min": 1, "max": 100 },
    { "key": "notify", "type": "boolean", "label": "启用通知", "default": true },
    { "key": "channel", "type": "select", "label": "渠道", "default": "log", "options": [{ "value": "log", "label": "仅界面" }] },
    { "key": "endpoint", "type": "text", "label": "地址", "default": "" }
  ]
}
```

`id` 必须与文件夹名一致，使用小写字母、数字、`-` 或 `_`；入口必须是插件文件夹内的 `.js` / `.mjs` 文件。推荐使用 `.mjs`，避免自定义插件目录的模块类型差异。不会将后台密码或账户信息传给插件。

### 插件自己的设置

- `settings` 是可选字段数组，声明后“插件管理”页会为每个字段渲染输入控件（`number` / `text` / `boolean` / `select`）。
- 每个字段的默认值取该字段的 `default`；没有 `default` 时取清单 `config` 中同名键；再没有则按类型回退（`0` / `false` / 第一个选项 / 空字符串）。
- 管理员在页面修改后保存到 `data/plugins.json` 的 `settings`，并**立即重启该插件**使其生效。未声明的键会被忽略，数值会按 `min` / `max` 收敛，`select` 只接受声明的取值。
- 不声明 `settings` 时，清单的 `config` 对象整体作为可编辑的文本设置（兼容旧插件）。

## 接口

`context` 在 `start` / `collect` / `stop` 中都会传入：

- `context.settings`：该插件的有效设置（默认值 + 管理员保存值）。
- `context.config`：与 `context.settings` 相同的对象，兼容旧写法。
- `context.global`：**只读**的后台整体设置快照，包含 `startedAt`、`dataDir`（后台数据目录，供插件放状态）、`pollIntervalSeconds`、`retentionHours`、`host.pollIntervalSeconds`、`servers[]`（`id` / `name` / `kind` / `online` / `url`（自动推导，可省略配置）/ `port` / `path`（项目目录或 systemd 的 `WorkingDirectory`）/ `unit`（systemd 单元名）/ `sudo`）。不含任何凭据。
- `context.service`：该实例绑定的服务 id（未绑定为空字符串）。
- `context.instance`：`{ id, label }`，实例标识。

### 多实例

同一插件可添加多个实例：每个实例有自己的设置、绑定的服务和独立的 Worker，可分别启用/停用。插件代码无需感知多实例——`context.settings` 已是该实例的有效设置，配合 `context.service` / `context.instance` 即可针对不同服务做不同的事。实例绑定的服务可在“设置”里修改，插件据此从 `context.global.servers[].path` 读取该服务的本地目录，无需再手填路径。

### 操作按钮（actions）

清单可声明 `actions: [{ key, label, danger? }]`，插件导出 `action(key, context)` 实现；实例上会显示对应按钮（需先启用实例）。接口为 `POST /api/plugins/instances/:id/actions/:key`。适合“立即更新”这类一次性操作——`action` 应**立即返回**并在后台继续，长任务通过后续 `collect` 汇报进度。回滚等自愈逻辑应在插件内部自动完成，不额外暴露按钮。

```javascript
export async function start(context) {
  // 可选：初始化。每次启用执行一次，读取 context.settings / context.global。
}

export async function collect(snapshot, context) {
  // 必须：每次主机采样后执行。
  // snapshot.host 为主机指标，snapshot.servers 为游戏节点健康状态。
  const threshold = context.settings.threshold ?? 90;
  return {
    status: snapshot.host.memoryPercent >= threshold ? '需要关注' : '正常',
    内存: `${snapshot.host.memoryPercent.toFixed(1)}%`,
    后台采样间隔: context.global.pollIntervalSeconds,
    告警: snapshot.host.memoryPercent >= threshold ? ['内存超过阈值'] : []
  };
}

export async function stop(context) {
  // 可选：停用或后台正常退出时清理。
}
```

### 返回值如何展示

`collect` 的返回值不再以原始 JSON 折叠展示，而是由页面结构化渲染：

- 对象按“字段 / 值”逐行展示；布尔值显示为“是 / 否”并高亮颜色。
- 数组渲染为列表，嵌套对象或数组继续递归展开。
- 数字、字符串直接显示，`null` / 缺失显示为 `—`。
- 建议返回 `{ status, ...指标 }` 形式，把关键结论放前面，数组用于告警、明细等项目。

返回 JSON 可序列化数据；返回值上限 64 KiB，每次 start / collect / stop 调用上限 5 秒；超时或错误后 Worker 会终止，页面标记异常，手动停用并重新启用可恢复。Worker 限制 JS 堆空间为 64 MiB，该限制不覆盖所有本机内存分配。

**插件代码具有后台用户的文件、网络及进程权限。Worker 是执行隔离，不是安全权限沙箱。只安装可信代码。** 控制台不渲染插件返回的 HTML。插件启停与设置保存有管理员登录和来源检查，并记录到审计日志。

## systemd

systemd 下插件和清单可读即可，不需授予插件目录写权限；插件自身要写文件时应使用被允许的数据目录（`context.global.dataDir`）。
