/** 服务端返回的 AI 配置视图（密钥只给掩码，系统提示词不下发）。 */
/** 服务端按「模型上下文窗口」自动推导出来的预算（只读）。 */
export interface AiDerivedBudget {
  /** 终端上下文长度（字符） */
  contextChars: number;
  /** 单条命令输出回灌长度（字符） */
  observeChars: number;
  /** 长期记忆容量（字符） */
  memoryMaxChars: number;
  /** 保留的对话轮数 */
  historyTurns: number;
  /** 单次任务步数上限 */
  maxSteps: number;
}

export interface AiPublicConfig {
  enabled: boolean;
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  includeContext: boolean;
  stream: boolean;
  hasKey: boolean;
  keyMask: string;
  /** 模型的上下文窗口（tokens）。其它预算全部按它换算 */
  contextWindow: number;
  /** 是否启用长期记忆 */
  memoryEnabled: boolean;
  /** 模型思考强度：'' = 不传（服务端默认），可选 low/medium/high */
  reasoningEffort: string;
  /** 服务端推导出的预算，界面只读展示 */
  derived?: AiDerivedBudget;
}
