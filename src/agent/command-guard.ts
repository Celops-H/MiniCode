/**
 * 同一 bash 命令的连续失败计数：连续失败达阈值后拒绝重跑同一命令，逼模型改道。
 *
 * 计数口径：
 * - 失败只认带失败原因的失败（超时、非零退出、启动失败）；用户打断是主动行为，
 *   不算失败，既不计入也不清零。
 * - 命令成功清零该命令的计数；换参数即换命令，各记各的。
 * - 键是命令原文，精确匹配。
 * - 拒绝一次即清零该命令计数：熔断只挡下一次相同命令，不永久封死。
 *   否则模型修好根因后以原命令重跑会被一直挡（如改完代码再跑同一条测试命令）。
 */

/** 同一命令连续失败达该次数即熔断，后续相同命令不再执行 */
export const MAX_CONSECUTIVE_FAILURES = 3;

/** 一次执行结果的三态：failed 失败（带原因）、succeeded 成功、ignored 不计入（用户打断） */
export type CommandOutcome = "failed" | "succeeded" | "ignored";

export class CommandFailureGuard {
  private readonly failures = new Map<string, number>();

  /** 该命令是否已熔断（连续失败达阈值） */
  isTripped(command: string): boolean {
    return (this.failures.get(command) ?? 0) >= MAX_CONSECUTIVE_FAILURES;
  }

  /**
   * 记录一次执行结果。
   * @param command 命令原文
   * @param outcome 结果三态：failed 累加、succeeded 清零、ignored 不计入
   * @returns 本次是否刚达熔断阈值
   */
  record(command: string, outcome: CommandOutcome): boolean {
    if (outcome === "ignored") return false;
    if (outcome === "succeeded") {
      this.reset(command);
      return false;
    }
    const count = (this.failures.get(command) ?? 0) + 1;
    this.failures.set(command, count);
    return count === MAX_CONSECUTIVE_FAILURES;
  }

  /** 清零该命令的计数：成功执行或熔断拒绝后调用 */
  reset(command: string): void {
    this.failures.delete(command);
  }
}

/** 熔断提示：附在触发阈值那次失败的回灌之后，告知后续相同命令会被拒绝 */
export function commandBreakerNotice(): string {
  return `[熔断] 同一命令连续失败 ${MAX_CONSECUTIVE_FAILURES} 次，后续相同命令不再执行，请修正命令或改用其他做法`;
}

/** 熔断后的拒绝回灌文本：工具未执行，模型据此改道 */
export function commandBreakerRefusal(): string {
  return `命令未执行：同一命令连续失败 ${MAX_CONSECUTIVE_FAILURES} 次，已停止重跑，请修正命令或改用其他做法`;
}
