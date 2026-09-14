import React from "react"
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter"
import { dracula } from "react-syntax-highlighter/dist/esm/styles/prism"

interface AnswerRendererProps {
  text: string
}

type Block =
  | { type: "code"; language: string; content: string }
  | { type: "text"; content: string }

/**
 * Splits streaming text into prose and fenced code blocks. An unterminated
 * fence (still streaming) is rendered as code too, so the block doesn't flip
 * between prose and code as the tokens land.
 */
function parseBlocks(text: string): Block[] {
  const blocks: Block[] = []
  const lines = text.split("\n")

  let inCode = false
  let language = ""
  let buffer: string[] = []

  const flush = () => {
    if (buffer.length === 0) return
    blocks.push(
      inCode
        ? { type: "code", language: language || "text", content: buffer.join("\n") }
        : { type: "text", content: buffer.join("\n") }
    )
    buffer = []
  }

  for (const line of lines) {
    const fence = line.match(/^\s*```(\w*)\s*$/)
    if (fence) {
      flush()
      if (!inCode) {
        inCode = true
        language = fence[1] || "text"
      } else {
        inCode = false
        language = ""
      }
      continue
    }
    buffer.push(line)
  }
  flush()

  return blocks
}

/** Renders **bold** and `code` spans inside a line of prose. */
function renderInline(line: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  let i = 0

  while ((match = pattern.exec(line)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(line.slice(lastIndex, match.index))
    }
    const token = match[0]
    if (token.startsWith("**")) {
      nodes.push(
        <strong key={`${keyPrefix}-b${i}`} className="text-white font-semibold">
          {token.slice(2, -2)}
        </strong>
      )
    } else {
      nodes.push(
        <code
          key={`${keyPrefix}-c${i}`}
          className="px-1 py-0.5 rounded bg-white/10 text-[11px] font-mono text-blue-200"
        >
          {token.slice(1, -1)}
        </code>
      )
    }
    lastIndex = match.index + token.length
    i++
  }

  if (lastIndex < line.length) nodes.push(line.slice(lastIndex))
  return nodes
}

export const AnswerRenderer: React.FC<AnswerRendererProps> = ({ text }) => {
  const blocks = parseBlocks(text)

  return (
    <div className="space-y-2">
      {blocks.map((block, blockIndex) => {
        if (block.type === "code") {
          return (
            <div key={blockIndex} className="rounded-md overflow-hidden">
              <SyntaxHighlighter
                language={block.language}
                style={dracula}
                customStyle={{
                  margin: 0,
                  padding: "10px",
                  fontSize: "11px",
                  lineHeight: "1.5",
                  background: "rgba(0,0,0,0.55)"
                }}
                wrapLongLines
              >
                {block.content}
              </SyntaxHighlighter>
            </div>
          )
        }

        return (
          <div key={blockIndex} className="space-y-1">
            {block.content.split("\n").map((line, lineIndex) => {
              const key = `${blockIndex}-${lineIndex}`
              const trimmed = line.trim()
              if (!trimmed) return <div key={key} className="h-1" />

              const bullet = trimmed.match(/^([-*•]|\d+\.)\s+(.*)$/)
              if (bullet) {
                return (
                  <div key={key} className="flex items-start gap-2">
                    <span className="text-blue-400/80 mt-[3px] text-[9px] shrink-0">●</span>
                    <span className="text-[12px] leading-[1.5] text-gray-100">
                      {renderInline(bullet[2], key)}
                    </span>
                  </div>
                )
              }

              const heading = trimmed.match(/^#{1,4}\s+(.*)$/)
              if (heading) {
                return (
                  <div key={key} className="text-[12px] font-semibold text-white pt-1">
                    {renderInline(heading[1], key)}
                  </div>
                )
              }

              return (
                <p key={key} className="text-[12px] leading-[1.5] text-gray-100">
                  {renderInline(trimmed, key)}
                </p>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

export default AnswerRenderer
