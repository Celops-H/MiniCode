/**
 * TUI 根视图（R1）：三区骨架（消息区 + 输入框 + 状态行）+ opentui 键盘接入。
 * 界面状态是 Solid store proxy（loop/createChannel 提供），组件内 props.state.xxx 属性访问
 * 即响应式订阅；键盘事件经 opentuiKeyToKey → mapKey → onAction 送回 reducer 落地。
 * （传函数 getter 给组件在 opentui reconciler 下不触发重渲染，改用 store proxy 属性访问。）
 */
import { useKeyboard } from "@opentui/solid";
import type { JSX } from "@opentui/solid";
import type { TuiState } from "../state.js";
import { promptEmpty } from "../state.js";
import type { TuiAction } from "../keymap.js";
import { mapKey } from "../keymap.js";
import { opentuiKeyToKey } from "../opentuiKeys.js";
import { Messages } from "./Messages.js";
import { PromptView } from "./Prompt.js";
import { StatusBar } from "./StatusBar.js";

export interface AppProps {
  /** 界面状态（Solid store proxy，属性访问即响应式） */
  state: TuiState;
  model: string;
  sessionId: string;
  /** 键盘/动作 → reducer + 副作用（loop 提供） */
  onAction: (action: TuiAction) => void;
}

export function App(props: AppProps): JSX.Element {
  useKeyboard((e) => {
    const key = opentuiKeyToKey(e);
    const s = props.state;
    props.onAction(
      mapKey(key, {
        inputEmpty: promptEmpty(s.prompt),
        browsingHistory: s.prompt.historyIndex !== -1,
        popup: s.modal ? "modal" : s.candidate ? "candidate" : undefined,
      }),
    );
  });

  return (
    <box flexDirection="column" flexGrow={1}>
      <Messages blocks={props.state.blocks} modelLabel={props.model} streaming={props.state.streaming} />
      <PromptView prompt={props.state.prompt} />
      <StatusBar model={props.model} sessionId={props.sessionId} status={props.state.status} />
    </box>
  );
}