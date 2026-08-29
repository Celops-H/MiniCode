/**
 * 层 2（reducer 可纯函数化部分）：/connect 弹窗 key 输入态的状态流转。
 * 交互链：/connect 打开供应商弹窗（loop 副作用）→ Enter 选中供应商进 key 输入态（loop modal-confirm）
 * → 字符键入弹窗内 key 缓冲（本文件 reducer）→ Enter 提交写配置（loop submitConnectKey，写配置行为
 * 由 connect.test 覆盖）→ 成功仅请求 reconfigure 保持同会话（runTui 返回信号，运行链真机核实）。
 * 本文件覆盖可纯函数断言的部分：key 缓冲增删、与普通输入态的隔离。
 */
import { it, expect, describe } from "vitest";
import { assistantMessage, COMMAND_MARKER, userMessage } from "../../src/core/index.js";
import { initState, reduceAction, reduceEvent, modelErrorText, resetToNewState, sessionModalTarget, type BlockView, type TuiState } from "../../src/tui/state.js";

function withKeyModal(state: TuiState): TuiState {
  return {
    ...state,
    modal: {
      kind: "connect-key",
      providerId: "deepseek",
      providerName: "DeepSeek",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      defaultModel: "deepseek-chat",
      key: "",
    },
  };
}

describe("connect key 输入态（弹窗内）", () => {
  it("字符追加进 key 缓冲，不进输入框", () => {
    let s = withKeyModal(initState([]));
    s = reduceAction(s, { type: "input", text: "s" });
    s = reduceAction(s, { type: "input", text: "k-abc" });
    expect(s.modal).toMatchObject({ kind: "connect-key", key: "sk-abc" });
    expect(s.prompt.lines[0]).toBe("");
  });

  it("backspace 删除 key 末字符", () => {
    let s = reduceAction(withKeyModal(initState([])), { type: "input", text: "sk-12345" });
    s = reduceAction(s, { type: "backspace" });
    s = reduceAction(s, { type: "backspace" });
    expect(s.modal).toMatchObject({ kind: "connect-key", key: "sk-123" });
  });

  it("key 输入态不弹 slash 候选（/ 开头的 key 不触发命令）", () => {
    let s = withKeyModal(initState([]));
    s = reduceAction(s, { type: "input", text: "/help" });
    expect(s.modal).toMatchObject({ kind: "connect-key", key: "/help" });
    expect(s.candidate).toBeUndefined();
  });

  it("普通输入态不受 connect-key 分支影响", () => {
    let s = initState([]);
    s = reduceAction(s, { type: "input", text: "hi" });
    expect(s.prompt.lines[0]).toBe("hi");
    expect(s.modal).toBeUndefined();
  });

  it("Enter（modal-confirm）/Esc（cancel）不落 key 缓冲——提交/取消由 loop 副作用落地", () => {
    const s = withKeyModal(initState([]));
    expect(reduceAction(s, { type: "modal-confirm" }).modal).toMatchObject({ kind: "connect-key", key: "" });
    expect(reduceAction(s, { type: "cancel" }).modal).toMatchObject({ kind: "connect-key", key: "" });
  });
});

describe("sessionModalTarget：/session 面板确认目标（P6-4 新建置顶，selected 0=新建、1..n=会话）", () => {
  const sessions = [{ id: "aaa" }, { id: "bbb" }];
  it("selected 0 = 新建会话（默认选项）", () => {
    expect(sessionModalTarget(0, sessions)).toEqual({ kind: "new" });
  });
  it("selected 1..n = 会话下标 selected-1", () => {
    expect(sessionModalTarget(1, sessions)).toEqual({ kind: "session", id: "aaa" });
    expect(sessionModalTarget(2, sessions)).toEqual({ kind: "session", id: "bbb" });
  });
  it("越界 selected 兜底为新建（防御，正常由 loop clamp）", () => {
    expect(sessionModalTarget(5, sessions)).toEqual({ kind: "new" });
    expect(sessionModalTarget(-1, sessions)).toEqual({ kind: "new" });
  });
});

describe("modelErrorText：模型调用失败的可读引导（C2 /model 边界）", () => {
  it("认证/未配置/未知模型类错误追加换模型与配 key 引导", () => {
    expect(modelErrorText("Provider openai 未配置认证：请设置环境变量")).toContain("/model 换模型");
    expect(modelErrorText("Incorrect API key provided. 401")).toContain("/connect");
    expect(modelErrorText("未知模型：gpt-9")).toContain("/model 换模型");
    // 厂商侧模型下架/改名（404 / 英文未找到）：同样给换模型引导
    expect(modelErrorText("404 The model 'gpt-9' does not exist")).toContain("/model 换模型");
    expect(modelErrorText("model not found")).toContain("/model 换模型");
  });
  it("其它错误保持原样，不误导", () => {
    expect(modelErrorText("会话存储写入失败")).toBe("会话存储写入失败");
  });
});

describe("C2 /model 边界：模型调用 error 事件渲染进消息区且回到空闲（不退出、可换回）", () => {
  it("无前缀内容时错误作为独立错误块，带引导且状态回空闲", () => {
    const s = reduceEvent(initState([]), { type: "error", message: "Incorrect API key" });
    expect(s.status).toBe("idle");
    const block = s.blocks.at(-1);
    expect(block).toMatchObject({ kind: "message", role: "assistant", isError: true });
    // 与 interact catch 同一套 modelErrorText：模型类错误附换模型/配 key 引导
    expect((block as { text: string }).text).toContain("/model 换模型");
  });
  it("非模型类 error 事件：错误块原样文本、不带模型引导", () => {
    const s = reduceEvent(initState([]), { type: "error", message: "存储写入失败" });
    const block = s.blocks.at(-1) as { text: string } | undefined;
    expect(block?.text).toBe("存储写入失败");
  });
  it("model_fallback 事件：追加常驻通知行到消息区（路由切换可见，非一闪而过 toast）", () => {
    const s = reduceEvent(initState([]), { type: "model_fallback", from: "gpt-4o", to: "deepseek-v4-flash" });
    expect(s.blocks.at(-1)).toMatchObject({
      kind: "notice",
      text: "模型 gpt-4o 不可用，已切换 deepseek-v4-flash",
    });
  });
});
describe("/clear 回会话新建态（resetToNewState 纯函数）", () => {
  it("消息区/流式/弹层/候选/聚焦/agent 树/输入清空，历史与标题保留", () => {
    let s = initState([]);
    s = reduceAction(s, { type: "input", text: "旧输入" });
    s = reduceAction(s, { type: "send" }); // 发送才写入输入历史（↑↓ 回看）
    s = { ...s, title: "旧标题", blocks: [{ kind: "message", id: "u1", role: "user", text: "旧对话", thinkingCollapsed: true }], agents: [{ path: "/root", status: "running", spawnedAt: null, completedAt: null }, { path: "/root/task_1", status: "running", spawnedAt: null, completedAt: null }] };
    const fresh = resetToNewState(s);
    expect(fresh.blocks).toEqual([]);
    expect(fresh.agents).toEqual([{ path: "/root", status: "running", spawnedAt: null, completedAt: null }]);
    expect(fresh.prompt.lines[0]).toBe("");
    expect(fresh.modal).toBeUndefined();
    expect(fresh.candidate).toBeUndefined();
    expect(fresh.focusIndex).toBe(-1);
    // 输入历史保留（↑↓ 可回看）
    expect(fresh.prompt.history).toContain("旧输入");
    // 会话标题保留（/clear 只清消息，标题不复位）
    expect(fresh.title).toBe("旧标题");
  });
});

describe("paste（bracketed paste 整段插入）", () => {
  it("单行粘贴：光标处插入、光标移到文本后", () => {
    let s = initState([]);
    s = reduceAction(s, { type: "input", text: "abc" });
    s = reduceAction(s, { type: "cursor", dir: "start" });
    s = reduceAction(s, { type: "paste", text: "X" });
    expect(s.prompt.lines[0]).toBe("Xabc");
    expect(s.prompt.curCol).toBe(1);
  });

  it("多行粘贴：\\n 拆行、光标落到末段尾", () => {
    let s = initState([]);
    s = reduceAction(s, { type: "paste", text: "a\nb\nc" });
    expect(s.prompt.lines).toEqual(["a", "b", "c"]);
    expect(s.prompt.curLine).toBe(2);
    expect(s.prompt.curCol).toBe(1);
  });

  it("粘贴在已有文本中间：首段接光标前、末段接光标后", () => {
    let s = initState([]);
    s = reduceAction(s, { type: "input", text: "xy" });
    s = reduceAction(s, { type: "cursor", dir: "start" });
    s = reduceAction(s, { type: "paste", text: "1\n2" });
    expect(s.prompt.lines).toEqual(["1", "2xy"]);
    expect(s.prompt.curLine).toBe(1);
    expect(s.prompt.curCol).toBe(1);
  });

  it("CRLF 归一化为换行", () => {
    let s = initState([]);
    s = reduceAction(s, { type: "paste", text: "a\r\nb\r\nc" });
    expect(s.prompt.lines).toEqual(["a", "b", "c"]);
  });

  it("粘贴超 20 行截断：保头尾（head 接光标前、tail 接光标后）、中间段截断、光标贴底", () => {
    let s = initState([]);
    s = reduceAction(s, { type: "paste", text: Array.from({ length: 25 }, (_, i) => `行${i}`).join("\n") });
    expect(s.prompt.lines).toHaveLength(20);
    // 头段（接光标前空内容）= 粘贴首行，尾段（接光标后空内容）= 粘贴末行——不再是旧实现「保前 20 丢尾」
    expect(s.prompt.lines[0]).toBe("行0");
    expect(s.prompt.lines[19]).toBe("行24");
    expect(s.prompt.curLine).toBe(19);
    // 中间被截断（丢了第 19~23 行中的一部分，保中间前段）
    expect(s.prompt.lines).not.toContain("行23");
  });

  it("粘贴超行截断：已有内容 + 光标在中间，光标后文本不丢（D-6=45）", () => {
    let s = initState([]);
    // 两行已有内容：第一行 aaaa、第二行 bbbb；光标在第一行末尾
    s = reduceAction(s, { type: "input", text: "aaaa" });
    s = reduceAction(s, { type: "newline" });
    s = reduceAction(s, { type: "input", text: "bbbb" });
    s = reduceAction(s, { type: "cursor", dir: "up" });
    // 光标在 (0,4)，粘贴 20 行（含换行）→ 结果 20 行封顶，光标后的 bbbb 必须保留
    s = reduceAction(s, { type: "paste", text: Array.from({ length: 20 }, (_, i) => `p${i}`).join("\n") });
    expect(s.prompt.lines).toHaveLength(20);
    expect(s.prompt.lines.at(-1)).toBe("bbbb"); // 光标后的第二行原内容保留
    expect(s.prompt.lines[0]).toBe("aaaap0"); // head 接光标前
  });

  it("connect-key 输入态粘贴：并入 key 缓冲", () => {
    let s = withKeyModal(initState([]));
    s = reduceAction(s, { type: "paste", text: "sk-12345" });
    expect(s.modal).toMatchObject({ kind: "connect-key", key: "sk-12345" });
  });

  it("connect-key 粘贴含换行/空白：key 清掉（API key 无空白，误带换行污染提交值，G-7）", () => {
    let s = withKeyModal(initState([]));
    s = reduceAction(s, { type: "paste", text: "sk-123\n456\t " });
    expect(s.modal).toMatchObject({ kind: "connect-key", key: "sk-123456" });
  });

  it("非 connect 弹窗打开时粘贴忽略（session/permission 输入框不可见，G-6 边界）", () => {
    const base = initState([]);
    const s1: TuiState = { ...base, modal: { kind: "session", sessions: [], selected: 0 } };
    expect(reduceAction(s1, { type: "paste", text: "x" }).prompt.lines).toEqual([""]);
    const s2: TuiState = { ...base, modal: { kind: "permission", toolName: "bash", content: "", argsText: "{}", selected: 0 } };
    expect(reduceAction(s2, { type: "paste", text: "x" }).prompt.lines).toEqual([""]);
  });
});

describe("输入编辑（D-2 Ctrl+U 连续删 / D-3 一键清空）", () => {
  it("Ctrl+U（delete-line）删当前行，行已空时继续删上一行（连续按住一行行往上清）", () => {
    let s = initState([]);
    s = reduceAction(s, { type: "input", text: "第一行" });
    s = reduceAction(s, { type: "newline" });
    s = reduceAction(s, { type: "input", text: "第二行" });
    // 光标在第二行末尾
    expect(s.prompt.lines).toEqual(["第一行", "第二行"]);
    // 第一次 Ctrl+U：清空当前行、光标行首
    s = reduceAction(s, { type: "delete-line" });
    expect(s.prompt.lines).toEqual(["第一行", ""]);
    expect(s.prompt.curLine).toBe(1);
    // 第二次 Ctrl+U：行已空 → 删掉空行，光标回上一行末尾
    s = reduceAction(s, { type: "delete-line" });
    expect(s.prompt.lines).toEqual(["第一行"]);
    expect(s.prompt.curLine).toBe(0);
    expect(s.prompt.curCol).toBe(3);
  });

  it("Ctrl+Shift+U（clear-input）一键清空输入框全部内容（含多行），清选区与候选", () => {
    let s = initState([]);
    s = reduceAction(s, { type: "input", text: "第一行" });
    s = reduceAction(s, { type: "newline" });
    s = reduceAction(s, { type: "input", text: "第二行" });
    // 制造选区（Shift 选择过）后一键清空
    s = reduceAction(s, { type: "select", dir: "left" });
    expect(s.prompt.sel).not.toBeNull();
    s = reduceAction(s, { type: "clear-input" });
    expect(s.prompt.lines).toEqual([""]);
    expect(s.prompt.curLine).toBe(0);
    expect(s.prompt.curCol).toBe(0);
    expect(s.prompt.sel).toBeNull();
  });
});

describe("命令消息重演（E24）", () => {
  it("initState 把 source=command 的用户消息重演为命令块（剥掉标记前缀）", () => {
    const state = initState([
      userMessage(`${COMMAND_MARKER}/init`, "command"),
      userMessage("普通输入"),
    ]);
    const command = state.blocks.find((b) => b.kind === "command");
    expect(command).toMatchObject({ kind: "command", text: "/init" });
    // 普通输入仍是消息块
    expect(state.blocks.some((b) => b.kind === "message" && b.text === "普通输入")).toBe(true);
  });
});

describe("消息署名跟随实际产出模型（E18）", () => {
  it("model_fallback 后 done 落的消息块署名为备选模型，并清除本轮暂存", () => {
    let s = initState([]);
    s = reduceEvent(s, { type: "text_delta", text: "回复" });
    s = reduceEvent(s, { type: "model_fallback", from: "m1", to: "m2" });
    s = reduceEvent(s, { type: "text_delta", text: "续" });
    s = reduceEvent(s, { type: "done", stopReason: "end_turn" });
    const blocks = s.blocks.filter((b) => b.kind === "message");
    const last = blocks.at(-1);
    expect(last).toMatchObject({ role: "assistant", model: "m2" });
    // done 即轮边界：暂存清除，下一轮未发生 fallback 时署名回落会话模型
    expect(s.activeModel).toBeUndefined();
  });

  it("initState 重演时署名取消息 meta.model，缺省回落会话当前模型", () => {
    const state = initState([
      assistantMessage([{ type: "text", text: "旧消息" }], { model: "old-model" }),
      assistantMessage([{ type: "text", text: "新消息" }]),
    ]);
    const blocks = state.blocks.filter(
      (b): b is Extract<BlockView, { kind: "message" }> => b.kind === "message" && b.role === "assistant",
    );
    expect(blocks[0]).toMatchObject({ model: "old-model" });
    expect(blocks[1]?.model).toBeUndefined();
  });
});
