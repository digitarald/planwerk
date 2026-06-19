"use client"

import { useEffect, useState, useCallback } from "react"
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command"
import { useShallow } from "zustand/react/shallow"
import { Plus, Columns3, Zap, ArrowRight } from "lucide-react"
import { useBoardStore, selectFilteredCards } from "@/lib/store/board-store"
import { COLUMNS } from "@/lib/types"

export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const cards = useBoardStore(useShallow(selectFilteredCards))
  const setDetailCard = useBoardStore((s) => s.setDetailCard)

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setOpen((prev) => !prev)
      }
    }
    document.addEventListener("keydown", down)
    return () => document.removeEventListener("keydown", down)
  }, [])

  const focusChatInput = useCallback(() => {
    setOpen(false)
    setTimeout(() => {
      const input = document.querySelector(
        '[placeholder="Ask or instruct..."]'
      ) as HTMLInputElement | null
      input?.focus()
    }, 100)
  }, [])

  const expandCard = useCallback(
    (cardId: string) => {
      setOpen(false)
      setDetailCard(cardId)
    },
    [setDetailCard]
  )

  const scrollToColumn = useCallback((columnId: string) => {
    setOpen(false)
    const columnEl = document.querySelector(`[data-column-id="${columnId}"]`)
    columnEl?.scrollIntoView({ behavior: "smooth", inline: "start" })
  }, [])

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <Command>
        <CommandInput placeholder="Search tasks, actions..." />
        <CommandList>
          <CommandEmpty>No results found.</CommandEmpty>

          <CommandGroup heading="Actions">
            <CommandItem onSelect={() => scrollToColumn("define")}>
              <Plus className="mr-2 h-4 w-4" />
              <span>New task</span>
              <span className="ml-auto text-xs text-muted-foreground">
                Focus Define column
              </span>
            </CommandItem>
            <CommandItem onSelect={focusChatInput}>
              <Zap className="mr-2 h-4 w-4" />
              <span>Ask orchestrator</span>
              <span className="ml-auto text-xs text-muted-foreground">
                Focus chat
              </span>
            </CommandItem>
          </CommandGroup>

          <CommandSeparator />

          <CommandGroup heading="Jump to column">
            {COLUMNS.map((col) => (
              <CommandItem key={col.id} onSelect={() => scrollToColumn(col.id)}>
                <Columns3 className="mr-2 h-4 w-4" />
                <span>{col.title}</span>
                <span className="ml-auto text-xs text-muted-foreground">
                  {col.description}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>

          {cards.length > 0 && (
            <>
              <CommandSeparator />
              <CommandGroup heading="Sessions">
                {cards.map((card) => (
                  <CommandItem key={card.id} onSelect={() => expandCard(card.id)}>
                    <ArrowRight className="mr-2 h-4 w-4" />
                    <span>{card.title}</span>
                    <span className="ml-auto text-xs text-muted-foreground capitalize">
                      {card.phase}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  )
}
