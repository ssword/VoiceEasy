import axios from 'axios'

const DEV_URL = 'http://localhost:3000/api/v1/tts'
const PROD_URL = import.meta.env.VITE_API_URL || '/api/v1/tts'
const baseURL = import.meta.env.MODE === 'development' ? DEV_URL : PROD_URL

const api = axios.create({
  baseURL: baseURL,
  timeout: 60000,
})

export interface EngineInfo {
  name: string
  languages: string[]
  voices: Voice[]
  supportsSubtitles: boolean
}

export interface GenerateRequest {
  text: string
  voice?: string
  rate?: string
  pitch?: string
  volume?: string
  useLLM?: boolean
  openaiBaseUrl?: string
  openaiKey?: string
  openaiModel?: string
  engine?: string
  enableInterruptions?: boolean
}
export interface TaskRequest {
  id: string
}
export type GenerationMode = 'stream' | 'buffered-timeline'
export interface TaskStreamResponse {
  stream: ReadableStream
  generationMode: GenerationMode
  taskId?: string
}
export interface TaskResponse {
  success: string
  url: string
  progress: number
  message?: string
}

export interface ResponseWrapper<T> {
  success: boolean
  data?: T
  code: number
  message?: string
}
export interface GenerateResponse {
  audio: string
  file: string
  srt?: string
  size?: number
  id: string
}
export type Voice = {
  Name: string
  cnName?: string
  Gender: string
  ContentCategories: string[]
  VoicePersonalities: string[]
  language?: string
  age?: string
  trait?: string
  scenario?: string
}
export interface Task {
  id: string
  fields: any
  status: string
  progress: number
  message: string
  code?: string | number
  result: any
  createdAt: Date
  updatedAt?: Date
  updateProgress?: (taskId: string, progress: number) => Task | undefined
}
export const getEngines = async () => {
  const response = await api.get<ResponseWrapper<EngineInfo[]>>('/engines')
  if (response.data?.code !== 200 || !response.data?.success) {
    throw new Error(response.data?.message || '获取引擎列表失败')
  }
  return response.data
}

export const getVoiceList = async (engine?: string) => {
  const params = engine ? { engine } : undefined
  const response = await api.get<ResponseWrapper<Voice[]>>('/voiceList', { params })
  if (response.data?.code !== 200 || !response.data?.success) {
    throw new Error(response.data?.message || '获取语音列表失败')
  }
  return response.data
}

export const generateTTS = async (data: GenerateRequest) => {
  const response = await api.post<ResponseWrapper<GenerateResponse>>('/generate', data)
  if (response.data?.code !== 200 || !response.data?.success) {
    throw new Error(response.data?.message || '生成语音失败')
  }
  return response.data
}
export const getTask = async (data: TaskRequest) => {
  const response = await api.get<ResponseWrapper<Task>>(`/task/${data.id}`)
  if (response.data?.code !== 200 || !response.data?.success) {
    throw new Error(response.data?.message || '获取任务')
  }
  return response.data
}
export const createTask = async (data: GenerateRequest) => {
  const response = await api.post<ResponseWrapper<Task>>(`/create`, data)
  if (response.data?.code !== 200 || !response.data?.success) {
    throw new Error(response.data?.message || '获取任务')
  }
  return response.data
}

export const createTaskStream = async (data: GenerateRequest) => {
  const response = await api.post<ReadableStream | ResponseWrapper<GenerateResponse>>(
    `/createStream`,
    data,
    {
      responseType: 'stream',
      adapter: 'fetch',
      timeout: 0,
    }
  )
  const ttsType = response.headers['x-generate-tts-type']
  const contentType = response.headers['content-type']
  if (
    response.status !== 200 ||
    ttsType === 'application/json' ||
    contentType?.includes?.('application/json')
  ) {
    const text = await new Response(response.data as any).text()
    const responseData = JSON.parse(text)
    return responseData
  }
  return {
    stream: response.data as ReadableStream,
    generationMode: ttsType === 'buffered-timeline' ? 'buffered-timeline' : 'stream',
    taskId: response.headers['x-generate-tts-id'],
  } satisfies TaskStreamResponse
}

export const downloadFile = (file: string) => `${api.defaults.baseURL}/download/${file}`
