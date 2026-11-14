import type { AttachmentMeta, MessageRole } from '@/core/db/schema';

/**
 * 确定性合成夹具生成器（任务 0001 阶段 4）。
 *
 * 约束：
 * - 固定 seed 的伪随机（mulberry32），同参数同 seed 必然同结果；
 * - **纯函数、不写文件**：生成结果不落盘、不入 git；
 * - 只用于单测与基准，不参与构建产物。
 */

export const FIXTURE_DEFAULT_SEED = 42;

export interface FixtureMessage {
  remoteId: string;
  role: MessageRole;
  content: string;
  thinking?: string;
  order: number;
  attachmentMeta?: AttachmentMeta[];
}

export interface FixtureConversation {
  remoteId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  messages: FixtureMessage[];
}

export interface FixtureOptions {
  conversations: number;
  messagesPerConv: number;
  /** 0..1，中文消息占比。 */
  chineseRatio: number;
  withThinking: boolean;
  withAttachments: boolean;
  seed?: number;
}

export interface FixtureData {
  conversations: FixtureConversation[];
  totalMessages: number;
}

const BASE_TIMESTAMP = 1_700_000_000_000;
const CONVERSATION_STEP_MS = 3_600_000;

const TITLE_POOL = [
  'Dexie 迁移怎么写',
  '中文分词方案对比',
  'MV3 service worker 生命周期',
  '索引重建策略',
  '搜索 P95 优化',
  'cursor 推进的坑',
  'Manifest V3 权限最小化',
  '分叉重放设计',
];

const CHINESE_SENTENCES = [
  '这个方案的关键在于游标如何推进，失败之后必须能够重试。',
  '先把只读链路跑通，再考虑写入类能力，风险更可控。',
  '索引重建应当与数据写入解耦，避免互相阻塞。',
  '如果页面改版导致选择器失效，界面应显示适配中而不是崩溃。',
];

const ENGLISH_SENTENCES = [
  'the cursor must not advance when a conversation fails, otherwise it never retries.',
  'keep the read-only path independent from any write capability.',
  'index rebuilding should be decoupled from ingestion.',
  'when selectors break, degrade to a status banner instead of crashing.',
];

const EMOJI_POOL = ['😀', '🚀', '🧩', '📌', '✅'];

const THINKING_TEXT = '先确认约束，再决定增量还是全量；不要猜页面结构。';

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: () => number, pool: readonly T[]): T {
  const index = Math.floor(random() * pool.length) % pool.length;
  return pool[index] as T;
}

export function generateFixtureData(options: FixtureOptions): FixtureData {
  const seed = options.seed ?? FIXTURE_DEFAULT_SEED;
  const random = mulberry32(seed);
  const conversations: FixtureConversation[] = [];

  for (let convIndex = 0; convIndex < options.conversations; convIndex += 1) {
    const createdAt = BASE_TIMESTAMP + convIndex * CONVERSATION_STEP_MS;
    const updatedAt = createdAt + Math.floor(random() * CONVERSATION_STEP_MS);
    const messages: FixtureMessage[] = [];

    for (let order = 0; order < options.messagesPerConv; order += 1) {
      const useChinese = random() < options.chineseRatio;
      const base = useChinese ? pick(random, CHINESE_SENTENCES) : pick(random, ENGLISH_SENTENCES);
      const withEmoji = random() < 0.15;
      const content = withEmoji ? `${base} ${pick(random, EMOJI_POOL)}` : base;

      const message: FixtureMessage = {
        remoteId: `m-${convIndex}-${order}`,
        role: order % 2 === 0 ? 'user' : 'assistant',
        content,
        order,
      };

      if (options.withThinking && message.role === 'assistant' && random() < 0.4) {
        message.thinking = THINKING_TEXT;
      }
      if (options.withAttachments && random() < 0.2) {
        message.attachmentMeta = [
          {
            name: `attachment-${convIndex}-${order}.pdf`,
            mimeType: 'application/pdf',
            size: 1024 * (order + 1),
          },
        ];
      }

      messages.push(message);
    }

    // 保证开关打开时一定有样本，避免用例因概率为 0 而空转。
    ensureThinking(messages, options.withThinking);
    ensureAttachments(messages, options.withAttachments);

    conversations.push({
      remoteId: `conv-${convIndex}`,
      title: pick(random, TITLE_POOL),
      createdAt,
      updatedAt,
      messageCount: options.messagesPerConv,
      messages,
    });
  }

  return {
    conversations,
    totalMessages: options.conversations * options.messagesPerConv,
  };
}

function ensureThinking(messages: FixtureMessage[], enabled: boolean): void {
  if (!enabled || messages.length === 0) return;
  if (messages.some((message) => message.thinking !== undefined)) return;
  const target = messages.find((message) => message.role === 'assistant') ?? messages[0];
  if (target !== undefined) target.thinking = THINKING_TEXT;
}

function ensureAttachments(messages: FixtureMessage[], enabled: boolean): void {
  if (!enabled || messages.length === 0) return;
  if (messages.some((message) => message.attachmentMeta !== undefined)) return;
  const target = messages[0];
  if (target !== undefined) {
    target.attachmentMeta = [
      { name: 'attachment-first.pdf', mimeType: 'application/pdf', size: 1024 },
    ];
  }
}
