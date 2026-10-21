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
import { Plus, Columns3, Zap, ArrowRight, Sparkles, Inbox, PanelTop, Rocket } from "lucide-react"
import { useBoardStore, selectFilteredCards } from "@/lib/store/board-store"
import { useUIStore } from "@/lib/store/ui-store"
import { COLUMNS } from "@/lib/types"

export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const cards = useBoardStore(useShallow(selectFilteredCards))
  const setDetailCard = useBoardStore((s) => s.setDetailCard)
  const openWelcome = useUIStore((s) => s.openWelcome)
  const setWorkspaceMode = useUIStore((s) => s.setWorkspaceMode)
  const openCoordinator = useUIStore((s) => s.openCoordinator)

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
    openCoordinator()
    setTimeout(() => {
      const input = document.querySelector(
        '[placeholder="Ask or instruct..."]'
      ) as HTMLInputElement | null
      input?.focus()
    }, 100)
  }, [openCoordinator])

  const expandCard = useCallback(
    (cardId: string) => {
      setOpen(false)
      setDetailCard(cardId)
    },
    [setDetailCard]
  )

  const scrollToColumn = useCallback((columnId: string) => {
    setOpen(false)
    setWorkspaceMode("board")
    setTimeout(() => {
      const columnEl = document.querySelector(`[data-column-id="${columnId}"]`)
      columnEl?.scrollIntoView({ behavior: "smooth", inline: "start" })
    }, 100)
  }, [setWorkspaceMode])

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <Command>
        <CommandInput placeholder="Search tasks, actions..." />
        <CommandList>
          <CommandEmpty>No results found.</CommandEmpty>

          <CommandGroup heading="Actions">
            <CommandItem
              onSelect={() => {
                setOpen(false)
                setWorkspaceMode("inbox")
              }}
            >
              <Inbox className="mr-2 h-4 w-4" />
              <span>Open inbox</span>
              <span className="ml-auto text-xs text-muted-foreground">
                Human handoffs
              </span>
            </CommandItem>
            <CommandItem
              onSelect={() => {
                setOpen(false)
                setWorkspaceMode("split")
              }}
            >
              <PanelTop className="mr-2 h-4 w-4" />
              <span>Open split view</span>
              <span className="ml-auto text-xs text-muted-foreground">
                Inbox + board
              </span>
            </CommandItem>
            <CommandItem
              onSelect={() => {
                setOpen(false)
                setWorkspaceMode("flightdeck")
              }}
            >
              <Rocket className="mr-2 h-4 w-4" />
              <span>Open flightdeck</span>
              <span className="ml-auto text-xs text-muted-foreground">
                Watch agents at work
              </span>
            </CommandItem>
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
            <CommandItem
              onSelect={() => {
                setOpen(false)
                openWelcome()
              }}
            >
              <Sparkles className="mr-2 h-4 w-4" />
              <span>Welcome to Planwerk</span>
              <span className="ml-auto text-xs text-muted-foreground">
                What is this?
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
