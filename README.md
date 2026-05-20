## 前言

新版本的Codex客户端默认使用Responses API,由本地端口代理接三方中转API的方式无法被Codex用chat模式识别(wire_api = "responses")。
该项目提供一个将本地中转端口转发返回的/v1/chat/completions转为/v1/responses供Codex识别调用的JS脚本
修改.codex/使Codex不再使用OpenAI服务商解析调用API，使用本地解析配置本地API

## 快速开始

### 1. 安装 Node.js
首先安装 Node.js（自带 npm）：
```bash
# Windows / Mac / Linux 通用（推荐官方安装）
# 访问官网下载：https://nodejs.org/
# 或使用包管理器快速安装
# Windows（Chocolatey）
choco install nodejs
```

### 2. 确认本地中转代理服务的端口，并修改CodexAPI调用配置
 - 找到C:\Users\你的用户\.codex\config.toml
 - 备份config.toml
 - 修改当前config.toml:
 - - 编辑内容:
```bash
#修改model(API_KEY允许的模型即可)
model = "gpt-5.5"
model_provider = "local-responses-adapter"

[model_providers.local-responses-adapter]
#修改配置base_url(默认使用8085端口，配合JS脚本的新转发API，修改前请先修改responses-shim.cjs中的const PORT = XX;)
name = "Local Responses Adapter"
base_url = "http://127.0.0.1:8085/v1"
wire_api = "responses"

[marketplaces.openai-bundled]
#沿用备份前的配置文件

[windows]
#沿用备份前的配置文件

[projects.XXX]
#沿用备份前的配置文件

[features]
#沿用备份前的配置文件

[plugins."browser@openai-bundled"]
#沿用备份前的配置文件

```
### 3. 配置responses-shim.cjs
```bash
# clone项目并配置文件
git clone https://github.com/YanChiCu/LocalChatAPI_for_Codex.git
#编辑responses-shim.cjs的TARGET_BASE参数
const const TARGET_BASE = "http://本地端口路由/v1";
```
### 4. 开启responses-shim.cjs

```bash
# clone项目并启动服务
cd LocalChatAPI_for_Codex
node responses-shim.cjs 
```



## 适用场景

适合以下情况：

1. 你使用的是新版 Codex。
2. Codex 提示 `wire_api = "chat" is no longer supported`。
3. Codex 会请求 `/v1/responses`。
4. 你的中转站或本地代理只支持 `/v1/chat/completions`。
5. 你想继续使用已有的 OpenAI 兼容 API、中转站、本地 adapter。
6. 你不想大改原来的本地代理程序。

## 环境要求
需要：

- Node.js 18 或更高版本
- 一个已经可用的 OpenAI 兼容接口，至少支持：

## 已知限制

本项目是兼容 shim，不是完整的 OpenAI Responses API 实现

## 常见问题

Q:Codex 报错：Missing environment variable: OPENAI_API_KEY
A:API_KEY应在原本地API调用中使用，如果codex的config.toml中包含env_key请删除该参数