import { useState } from 'react'
import type { ListDto } from '@shared/types'
import { useListMutations, useLists, useWallNote, useWallNoteMutation } from '../api/hooks'
import { Card, CheckCircle, EmptyNote, GhostButton, PrimaryButton, TextInput } from '../components/ui'

const LIST_COLORS = ['#46A758', '#0091FF', '#FFB224', '#6E56CF', '#E5484D', '#D95B3A']

function WallNoteCard() {
  const note = useWallNote()
  const mutation = useWallNoteMutation()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const text = note.data?.text ?? ''
  return (
    <Card>
      <div className="mb-1 flex items-center gap-2">
        <h2 className="flex-1 font-display text-xl font-semibold">Family note</h2>
        {!editing && (
          <GhostButton
            onClick={() => {
              setDraft(text)
              setEditing(true)
            }}
          >
            Edit
          </GhostButton>
        )}
      </div>
      {editing ? (
        <div className="flex flex-col gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="min-h-20 w-full rounded-xl border border-line bg-paper p-2 text-base font-semibold outline-none focus:border-ember"
            placeholder="Where are the keys?"
          />
          <div className="flex gap-2">
            <GhostButton onClick={() => setEditing(false)}>Cancel</GhostButton>
            <PrimaryButton
              onClick={() => {
                mutation.mutate({ text: draft })
                setEditing(false)
              }}
            >
              Save
            </PrimaryButton>
          </div>
        </div>
      ) : (
        <p className="whitespace-pre-wrap text-base font-semibold text-ink-soft">
          {text || 'No note yet — tap Edit to leave one for the family.'}
        </p>
      )}
    </Card>
  )
}

export function ListsPage() {
  const { data: lists = [], isPending } = useLists()
  const mutations = useListMutations()
  const [newName, setNewName] = useState('')
  const [adding, setAdding] = useState(false)

  const createList = (): void => {
    const name = newName.trim()
    if (!name) return
    mutations.create.mutate({ name, color: LIST_COLORS[lists.length % LIST_COLORS.length], kind: 'custom' })
    setNewName('')
    setAdding(false)
  }

  return (
    <div className="flex flex-col gap-4">
      <WallNoteCard />
      {isPending && <EmptyNote>Loading…</EmptyNote>}
      {!isPending && lists.length === 0 && <EmptyNote>No lists yet — create the first one below.</EmptyNote>}
      {lists.map((list) => (
        <ListCard key={list.id} list={list} mutations={mutations} />
      ))}

      {adding ? (
        <Card>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              createList()
            }}
          >
            <TextInput value={newName} onChange={setNewName} placeholder="List name" autoFocus />
            <PrimaryButton type="submit" disabled={!newName.trim()}>
              Create
            </PrimaryButton>
          </form>
        </Card>
      ) : (
        <GhostButton onClick={() => setAdding(true)}>+ New list</GhostButton>
      )}
    </div>
  )
}

function ListCard({ list, mutations }: { list: ListDto; mutations: ReturnType<typeof useListMutations> }) {
  const [text, setText] = useState('')
  const [showDone, setShowDone] = useState(false)
  const unchecked = list.items.filter((i) => !i.checked)
  const checked = list.items.filter((i) => i.checked)

  const add = (): void => {
    const t = text.trim()
    if (!t) return
    mutations.addItem.mutate({ listId: list.id, text: t })
    setText('')
  }

  return (
    <Card>
      <div className="mb-1 flex items-center gap-2.5">
        <span className="h-3.5 w-3.5 shrink-0 rounded-full" style={{ backgroundColor: list.color }} />
        <h2 className="flex-1 truncate font-display text-xl font-semibold">{list.name}</h2>
        <GhostButton onClick={() => shareList(list)}>Share</GhostButton>
        {checked.length > 0 && (
          <button
            type="button"
            onClick={() => mutations.clearChecked.mutate({ listId: list.id })}
            className="pressable rounded-lg px-2 py-1 text-sm font-extrabold text-ink-faint"
          >
            Clear {checked.length} done
          </button>
        )}
      </div>

      {unchecked.map((item) => (
        <div key={item.id} className="flex items-center border-b border-line/60 last:border-0">
          <CheckCircle
            checked={false}
            color={list.color}
            onTap={() => mutations.toggleItem.mutate({ id: item.id })}
            label={`Check off ${item.text}`}
          />
          <span className="min-w-0 flex-1 truncate py-2 text-base font-semibold">{item.text}</span>
        </div>
      ))}
      {unchecked.length === 0 && checked.length > 0 && (
        <p className="py-2 text-sm font-bold text-ink-faint">All done! 🎉</p>
      )}

      {checked.length > 0 && (
        <button
          type="button"
          onClick={() => setShowDone((v) => !v)}
          className="pressable mt-1 text-sm font-extrabold text-ink-faint"
        >
          {showDone ? 'Hide' : 'Show'} {checked.length} done
        </button>
      )}
      {showDone &&
        checked.map((item) => (
          <div key={item.id} className="flex items-center opacity-60">
            <CheckCircle
              checked
              color={list.color}
              onTap={() => mutations.toggleItem.mutate({ id: item.id })}
              label={`Uncheck ${item.text}`}
            />
            <span className="min-w-0 flex-1 truncate py-2 text-base font-semibold line-through">{item.text}</span>
          </div>
        ))}

      <form
        className="mt-2 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          add()
        }}
      >
        <TextInput value={text} onChange={setText} placeholder="Add an item" />
        <PrimaryButton type="submit" disabled={!text.trim()}>
          Add
        </PrimaryButton>
      </form>
    </Card>
  )
}


/** Share the unchecked items as plain text — the shopper's shopping list. */
function shareList(list: ListDto): void {
  const items = list.items.filter((i) => !i.checked).map((i) => `• ${i.text}`)
  const text = `${list.name} (${items.length})\n\n${items.join('\n')}`
  if (navigator.share) {
    void navigator.share({ title: list.name, text }).catch(() => undefined)
  } else {
    void navigator.clipboard?.writeText(text)
  }
}
