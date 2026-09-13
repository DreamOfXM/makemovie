import { Queue, Worker } from 'bullmq'

const connection = { url: process.env.REDIS_URL || 'redis://localhost:6380' }
const queue = new Queue('quality-check', { connection })
new Worker('quality-check', async job => ({ id: job.id, status: 'accepted' }), { connection })

await queue.add('worker-started', { timestamp: new Date().toISOString() }, { removeOnComplete: true })
process.stdout.write('worker ready\n')
