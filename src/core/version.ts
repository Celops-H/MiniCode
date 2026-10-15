/**
 * 项目版本号唯一定义处：命令行 --version、轨迹 header、MCP 握手 clientInfo 共用。
 * 与 package.json 的 version 必须一致，一致性由 tests/core/version.test.ts 守护。
 * 放 core 是因为引用方跨层：入口、TUI、MCP 传输各自所在层都不宜当出处。
 */
export const MINICODE_VERSION = "0.0.1";
