/**
 * test-model-cognition.mjs — 模型認知系統測試腳本
 *
 * 用法：bun run config/test-model-cognition.mjs
 */
import { getCognition, suggestModel, analyzeStall } from './model-cognition.js';

// ── 測試 getCognition ──
const models = ['qwen3.6-plus-coder', 'qwen3.6-max-preview', 'qwen3.6-27b', 'qwen-flash', 'qwq'];
console.log('═══ getCognition 測試 ═══');
for (const model of models) {
  const cog = getCognition(model);
  const dims = Object.entries(cog.cognition).map(([k, v]) => `${k}:${v}`).join(' ');
  console.log(`[${model}] ${dims}`);
  console.log(`  弱點: ${cog.weakness.join(', ')}`);
  console.log(`  特徵: ${cog.features.join(', ')}`);
}

// ── 測試 suggestModel ──
console.log('\n═══ suggestModel 測試 ═══');
const available = ['qwen3.6-plus', 'qwen3.6-plus-coder', 'qwen3.6-max-preview', 'qwen3.6-27b'];

const forCoding = suggestModel('coding', { availableModels: available });
console.log(`編碼任務建議: ${forCoding}`);

const forReasoning = suggestModel('reasoning', { availableModels: available });
console.log(`推理任務建議: ${forReasoning}`);

const forChat = suggestModel('chat', { availableModels: available });
console.log(`聊天任務建議: ${forChat}`);

const forToolHeavy = suggestModel('tool-heavy', { availableModels: available });
console.log(`工具密集建議: ${forToolHeavy}`);

// ── 測試 analyzeStall ──
console.log('\n═══ analyzeStall 測試 ═══');
const stallResult = analyzeStall('qwen3.6-max-preview', {
  taskType: 'coding',
  contentLength: 200,
  hasToolHistory: false,
  isTimeout: false,
  isEmpty: false,
});
console.log(`停滯分析: ${stallResult.reason}`);
console.log(`修正建議: ${stallResult.suggestion.slice(0, 80)}...`);
console.log(`建議切換: ${stallResult.switchModel}`);

console.log('\n✅ 模型認知系統測試完成');
