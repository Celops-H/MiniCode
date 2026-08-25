/**
 * TUI 驱动循环（R1）：界面状态（Solid store）与动作分发。
 * M4.3 的交互经验保留到 R1b：interact 接入（inputs/onEvent/hooks）、approver 队列一次放行全部、
 * /compact 运行守卫、错误渲染进消息区不退出、turn 内打断、modal 态保留 Ctrl+C/D。
 * 本文件为纯 action → reducer 的通道；副作用（真实发送 / 权限审批 / 命令执行）在 R1b 接入 interact 后扩展。
 */
import { createStore, reconcile } from "solid-js/store";
import type { Message } from "../core/index.js";
import type { TuiAction } from "./keymap.js";
import { initState, reduceAction, type TuiState } from "./state.js";

export interface TuiChannel {
  /** 界面状态（Solid store proxy：组件内 props.state.xxx 属性访问即响应式） */
  state: TuiState;
  /** 动作 → reducer 落地（纯 reducer 动作；副作用动作由 loop 在下一步接管） */
  onAction: (action: TuiAction) => void;
}

/** 建立界面通道：初始历史消息 → 初始 state，动作经 reducer 整树替换 store */
export function createChannel(initialMessages: Message[]): TuiChannel {
  const [state, setState] = createStore<TuiState>(initState(initialMessages));
  // setState 用 reconcile 整树替换：reducer 产出全新 state 引用，缺失顶层键（弹层/提示等）一并清除，
  // 不因 store merge 语义残留旧值
  return {
    get state() {
      return state;
    },
    onAction: (action) => setState(reconcile(reduceAction(state, action))),
  };
}