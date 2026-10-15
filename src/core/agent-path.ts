/**
 * 根 agent 路径唯一定义处：协调者的 AgentPath 与轨迹行、事件负载的 agentPath 都用它。
 * 与 AgentPath.root().toString() 恒等，一致性由 tests/agent/agent-path.test.ts 守护。
 * 放 core 是因为引用方跨层：agent 发事件、tools 取消费者路径、TUI 归并状态、
 * observability 落轨迹行，各自所在层都不宜当出处。
 */
export const ROOT_AGENT_PATH = "/root";
