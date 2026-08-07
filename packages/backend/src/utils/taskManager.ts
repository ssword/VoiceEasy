import crypto from 'crypto'
import { memoryUsage } from 'process'
import { Request, Response, NextFunction } from 'express'
import { formatFileSize } from '.'
import { logger } from './logger'
import type { GenerationDiagnostics } from './diagnostics'

interface Options {
  prefix?: string
  length?: number
}
interface TaskManagerOptions {
  length?: number
}
export type TaskStatus = 'pending' | 'completed' | 'failed' | 'cancelled'

export class TaskConflictError extends Error {
  readonly statusCode = 409
  readonly errorCode = 'TASK_ALREADY_PENDING'

  constructor(readonly taskId: string) {
    super(`Task ${taskId} is already pending`)
    this.name = 'TaskConflictError'
  }
}

export interface Task {
  id: string
  fields: any
  status: TaskStatus
  progress: number
  message: string
  code?: string | number
  result: any
  createdAt: Date
  updatedAt?: Date
  updateProgress?: (taskId: string, progress: number) => Task | undefined
  endTask?: (taskId?: string) => Task
  context?: {
    req?: Request
    res?: Response
    body?: any
    result?: TTSResult
    segment?: Segment
    lang?: string
    voiceList?: VoiceConfig[]
    engine?: string
    diagnostics?: GenerationDiagnostics
    abortSignal?: AbortSignal
  }
}
class TaskManager {
  tasks: Map<string, Task>
  MAX_TASKS: number
  constructor(options?: TaskManagerOptions) {
    this.tasks = new Map()
    this.MAX_TASKS = options?.length || 10
  }

  generateTaskId(fields: any, options: Options = {}) {
    const { prefix = 'task', length = 32 } = options
    const hash = crypto.createHash('md5')

    Object.keys(fields)
      .sort()
      .forEach((key) => {
        const value = fields[key]
        if (!value) return
        hash.update(key)
        if (typeof value === 'string' && value.length > 1000) {
          for (let i = 0; i < value.length; i += 1000) {
            hash.update(value.slice(i, i + 1000))
          }
        } else {
          hash.update(JSON.stringify(value))
        }
      })

    const hashValue = hash.digest('hex')
    return `${prefix}${hashValue.slice(0, length)}`
  }

  createTask(fields: any, options?: Options): Task {
    const taskId = this.generateTaskId(fields, options)
    if (this.isTaskPending(taskId)) {
      throw new TaskConflictError(taskId)
    }
    if (this.getPendingTasks()?.length >= this.MAX_TASKS) {
      throw new Error(`Cannot create more than ${this.MAX_TASKS} tasks!`)
    }
    const task: Task = {
      id: taskId,
      fields,
      status: 'pending',
      progress: 0,
      message: '',
      result: null,
      createdAt: new Date(),
      updateProgress: (_taskId, progress) => this.updateProgress(taskId, progress, task),
      endTask: () => this.finishTask(taskId, task),
    }
    this.tasks.set(taskId, task)
    return task
  }

  finishTask(taskId: string, expectedTask?: Task) {
    const { task, transitioned } = this.transitionPendingTask(taskId, expectedTask, (current) => {
      current.status = 'completed'
      current.progress = 100
    })
    if (transitioned) logger.info(`Task ${taskId} completed`)
    return task
  }
  isTaskPending(taskId: string) {
    return this.getTask(taskId)?.status === 'pending' || false
  }
  getTask(taskId: string) {
    return this.tasks.get(taskId) || null
  }
  failTask(
    taskId: string,
    { code, message }: { code?: number; message: string },
    expectedTask?: Task
  ) {
    return this.transitionPendingTask(taskId, expectedTask, (task) => {
      task.status = 'failed'
      task.message = message
      task.code = code
    }).task
  }
  cancelTask(taskId: string, message = 'Client disconnected', expectedTask?: Task) {
    return this.transitionPendingTask(taskId, expectedTask, (task) => {
      task.status = 'cancelled'
      task.message = message
    }).task
  }
  updateProgress(taskId: string, progress: number, expectedTask?: Task): Task | undefined {
    return this.transitionPendingTask(taskId, expectedTask, (task) => {
      task.progress = progress
    }).task
  }
  updateTask(
    taskId: string,
    {
      status = 'completed' as TaskStatus,
      progress = 100,
      result,
    }: { status?: TaskStatus; progress?: number; result: any },
    expectedTask?: Task
  ) {
    return this.transitionPendingTask(taskId, expectedTask, (task) => {
      task.status = status
      task.progress = progress
      task.result = result
    }).task
  }
  getTaskLength() {
    return this.tasks.size
  }
  getPendingTasks() {
    return Array.from(this.tasks.values()).filter((task) => task.status === 'pending')
  }
  getTaskStats() {
    const tasks = Array.from(this.tasks.values())
    const memory = {
      heapUsed: formatFileSize(memoryUsage().heapUsed),
      heapTotal: formatFileSize(memoryUsage().heapTotal),
      rss: formatFileSize(memoryUsage().rss),
    }
    const stats = {
      totalTasks: this.getTaskLength(),
      completedTasks: tasks.filter((task) => task.status === 'completed').length,
      failedTasks: tasks.filter((task) => task.status === 'failed').length,
      cancelledTasks: tasks.filter((task) => task.status === 'cancelled').length,
      pendingTasks: tasks.filter((task) => task.status === 'pending').length,
      memory,
    }
    return stats
  }

  private requireTask(taskId: string): Task {
    const task = this.getTask(taskId)
    if (!task) throw new Error(`Cannot find task: ${taskId}`)
    return task
  }

  private transitionPendingTask(
    taskId: string,
    expectedTask: Task | undefined,
    transition: (task: Task) => void
  ): { task: Task; transitioned: boolean } {
    const currentTask = this.requireTask(taskId)
    if (expectedTask && currentTask !== expectedTask) {
      return { task: expectedTask, transitioned: false }
    }
    if (currentTask.status !== 'pending') {
      return { task: currentTask, transitioned: false }
    }
    transition(currentTask)
    currentTask.updatedAt = new Date()
    this.tasks.set(taskId, currentTask)
    return { task: currentTask, transitioned: true }
  }
}
const instance = new TaskManager()
export default instance
