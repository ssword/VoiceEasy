<template>
  <div v-if="generating" class="generation-progress" role="status">
    <span class="generation-progress__phase">{{ phaseLabel }}</span>
    <progress :value="progress" max="100">{{ progress }}%</progress>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { GenerationPhase } from '@/stores/generation'

const props = defineProps<{
  generating: boolean
  progress: number
  phase: GenerationPhase
}>()

const phaseLabel = computed(() => {
  switch (props.phase) {
    case 'generating-segments':
      return '生成 Segment'
    case 'timeline-mix':
      return '时间轴混音'
    case 'streaming':
      return '流式生成'
    default:
      return ''
  }
})
</script>

<style scoped>
.generation-progress {
  display: grid;
  gap: 8px;
  justify-items: center;
  margin: 16px auto;
  max-width: 400px;
}

.generation-progress__phase {
  color: #606266;
  font-size: 14px;
}

progress {
  accent-color: #52c41a;
  height: 12px;
  width: 100%;
}
</style>
