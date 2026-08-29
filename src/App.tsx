import { useEffect, useState } from 'react'

declare global {
  interface Document {
    modelContext?: {
      registerTool: (tool: unknown) => Promise<unknown>
    }
  }
}

export default function App() {
  const [count, setCount] = useState(0)
  const [toolReady, setToolReady] = useState(false)

  useEffect(() => {
    if (typeof document.modelContext?.registerTool !== 'function') return

    document.modelContext.registerTool({
      name: 'set_counter',
      description: 'Set the counter on the Tailor test page to a specific number.',
      inputSchema: {
        type: 'object',
        properties: {
          value: { type: 'integer', minimum: 0, maximum: 999 },
        },
        required: ['value'],
        additionalProperties: false,
      },
      execute: async ({ value }: { value: number }) => {
        setCount(value)
        return { summary: `Counter is now ${value}.`, value }
      },
    })

    setToolReady(true)
  }, [])

  return (
    <main style={{ fontFamily: 'system-ui', padding: 40 }}>
      <h1>Tailor</h1>
      <p style={{ fontSize: 48, margin: '24px 0' }}>{count}</p>
      <button onClick={() => setCount(count + 1)}>+1</button>
      <p style={{ marginTop: 32, color: toolReady ? 'green' : 'gray' }}>
        {toolReady ? 'WebMCP: 1 tool registered' : 'WebMCP: not available'}
      </p>
    </main>
  )
}

