/**
 * vitest 全局准备：测试反复创建 TUI 渲染器，opentui 的 TerminalConsoleCache 每次构造都在自身
 * EventEmitter 上挂一组 "entry" 监听且无移除逻辑，单个实例内累积超默认上限（10）触发
 * MaxListenersExceededWarning 刷屏。生产进程只创建一次渲染器不会出现；这里放宽测试进程中
 * 未显式设上限的 EventEmitter 默认值（0=不限），只压噪音不改断言行为。
 */
import { EventEmitter } from "node:events";

EventEmitter.defaultMaxListeners = 0;
