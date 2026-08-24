/**
 * Agent 层级路径（DESIGN 11.1）：`/root` 固定根，子 agent 形如 `/root/task_1`。
 * 段名限小写字母/数字/下划线，`root`/`.`/`..` 为保留名。
 * 校验失败返回可读错误文本，由工具回灌给模型（不抛原始堆栈）。
 */

const ROOT = "/root";
const RESERVED_NAMES = new Set(["root", ".", ".."]);

export class AgentPath {
  private constructor(private readonly value: string) {}

  /** 根路径 `/root`（协调者 = root 系统提示角色，DESIGN 11.1） */
  static root(): AgentPath {
    return new AgentPath(ROOT);
  }

  /**
   * 解析绝对路径；非法返回错误文本。
   * @param input 绝对路径（如 `/root/task_1`）
   * @returns 解析成功返回路径，失败返回可读错误信息
   */
  static parse(input: string): AgentPath | string {
    if (input === ROOT) return new AgentPath(input);
    if (!input.startsWith(`${ROOT}/`)) return "绝对 agent 路径必须以 /root 开头";
    if (input.endsWith("/")) return "agent 路径不能以 / 结尾";
    // 首段 root 已由前缀保证，只校验其余段
    const rest = input.slice(ROOT.length + 1);
    for (const segment of rest.split("/")) {
      const error = validateAgentName(segment);
      if (error) return error;
    }
    return new AgentPath(input);
  }

  isRoot(): boolean {
    return this.value === ROOT;
  }

  /** 末段名；root 返回 `root` */
  name(): string {
    if (this.isRoot()) return "root";
    return this.value.slice(this.value.lastIndexOf("/") + 1);
  }

  /** 父路径；root 的父是自身（root 无父） */
  parent(): AgentPath {
    if (this.isRoot()) return this;
    return AgentPath.parse(this.value.slice(0, this.value.lastIndexOf("/"))) as AgentPath;
  }

  /** 派生直接子路径（子 agent 名须合法） */
  join(agentName: string): AgentPath | string {
    const error = validateAgentName(agentName);
    if (error) return error;
    return AgentPath.parse(`${this.value}/${agentName}`);
  }

  /**
   * 解析引用：绝对引用（`/` 开头）直接解析；相对引用相对当前路径拼接。
   * 返回子路径或错误文本。
   */
  resolve(reference: string): AgentPath | string {
    if (reference === ROOT) return AgentPath.root();
    if (reference.startsWith("/")) return AgentPath.parse(reference);
    const error = validateRelativeReference(reference);
    if (error) return error;
    return AgentPath.parse(`${this.value}/${reference}`);
  }

  toString(): string {
    return this.value;
  }
}

/** 校验单个段名；非法返回可读错误信息 */
function validateAgentName(name: string): string | undefined {
  if (!name) return "agent 名不能为空";
  if (RESERVED_NAMES.has(name)) return `agent 名 ${name} 是保留名`;
  if (name.includes("/")) return "agent 名不能包含 /";
  if (!/^[a-z0-9_]+$/.test(name)) return "agent 名只能用小写字母、数字和下划线";
  return undefined;
}

/** 校验相对引用：逐段校验，不能以 / 结尾 */
function validateRelativeReference(reference: string): string | undefined {
  if (reference.endsWith("/")) return "相对 agent 路径不能以 / 结尾";
  for (const segment of reference.split("/")) {
    const error = validateAgentName(segment);
    if (error) return error;
  }
  return undefined;
}