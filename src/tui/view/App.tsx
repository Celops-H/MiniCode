/**
 * TUI 根视图（R1）：三区骨架（消息区 + 输入框 + 状态行）+ opentui 键盘接入。
 * 界面状态是 Solid store proxy（loop/createChannel 提供），组件内 props.state.xxx 属性访问
 * 即响应式订阅；键盘事件经 opentuiKeyToKey → mapKey → onAction 送回 reducer 落地。
 * （传函数 getter 给组件在 opentui reconciler 下不触发重渲染，改用 store proxy 属性访问。）
 */
import { useKeyboard, usePaste } from "@opentui/solid";
import type { JSX } from "@opentui/solid";
import type { TuiState } from "../state.js";
import { promptEmpty } from "../state.js";
import type { TuiAction } from "../keymap.js";
import { mapKey } from "../keymap.js";
import { opentuiKeyToKey } from "../opentuiKeys.js";
import { Messages } from "./Messages.js";
import { PromptView } from "./Prompt.js";
import { StatusBar } from "./StatusBar.js";
import { ModalView } from "./Modal.js";
import { AgentStrip } from "./AgentStrip.js";
import { theme } from "./theme.js";

export interface AppProps {
  /** 界面状态（Solid store proxy，属性访问即响应式；title 在 state 内，/rename 同步） */
  state: TuiState;
  model: string;
  /** 键盘/动作 → reducer + 副作用（loop 提供） */
  onAction: (action: TuiAction) => void;
}

export function App(props: AppProps): JSX.Element {
  useKeyboard((e) => {
    const key = opentuiKeyToKey(e);
    const s = props.state;
    let action = mapKey(key, {
      inputEmpty: promptEmpty(s.prompt),
      browsingHistory: s.prompt.historyIndex !== -1,
      popup: s.modal ? "modal" : s.candidate ? "candidate" : undefined,
      // /model 弹窗 ←→ 用于思考等级（区别于其它弹窗的选项导航）
      modalKind: s.modal?.kind,
    });
    // 无 slash 候选时 Tab = 在可折叠块间移动聚焦（键盘用户定位；展开/收起已改鼠标点击 fold-at）
    if (action.type === "complete" && !s.candidate) action = { type: "toggle-focus" };
    props.onAction(action);
  });

  // 粘贴：bracketed paste 整段文本 → 输入框插入（Ctrl+V/Shift+Insert 由终端触发，opentui 识别
  // paste 块发 PasteEvent；多行拆行、超行数截断、/connect key 输入态并入 key 缓冲由 reducer 处理）
  usePaste((e) => {
    const bytes = (e as { bytes?: Uint8Array }).bytes;
    if (!bytes || bytes.length === 0) return;
    const text = new TextDecoder().decode(bytes);
    if (text) props.onAction({ type: "paste", text });
  });

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={theme.background}>
      <Messages
        blocks={props.state.blocks}
        modelLabel={props.model}
        streaming={props.state.streaming}
        onFoldAt={(index) => props.onAction({ type: "fold-at", index })}
      />
      {props.state.toast ? (
        <box flexShrink={0} paddingX={1}>
          <text fg={theme.textMuted}>{props.state.toast.text}</text>
        </box>
      ) : null}
      {props.state.modal ? <ModalView modal={props.state.modal} /> : null}
      <PromptView
        prompt={props.state.prompt}
        candidate={props.state.candidate}
        // /connect key 弹窗输入时隐藏底部输入框光标（光标移到弹窗内 key 输入区）
        showCursor={props.state.modal?.kind !== "connect-key"}
      />
      <StatusBar model={props.model} title={props.state.title} status={props.state.status} permissionMode={props.state.permissionMode} />
      {props.state.agents.length > 0 ? <AgentStrip agents={props.state.agents} /> : null}
    </box>
  );
}