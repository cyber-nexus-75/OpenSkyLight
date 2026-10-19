import { useState } from 'react'
import type { PersonDto } from '@shared/types'
import { initials, textOn } from '../lib/format'

/**
 * Person avatar circle: the photo when set, initials otherwise.
 * Used everywhere a person is shown so the fallback stays consistent.
 */
export function Avatar({
  person,
  className,
  textClassName = 'font-extrabold'
}: {
  person: Pick<PersonDto, 'id' | 'name' | 'color' | 'avatarUrl'>
  className: string
  textClassName?: string
}) {
  const [failed, setFailed] = useState(false)
  if (person.avatarUrl && !failed) {
    return (
      <img
        src={person.avatarUrl}
        alt={person.name}
        className={`${className} object-cover`}
        onError={() => setFailed(true)}
      />
    )
  }
  return (
    <span
      className={`${className} flex items-center justify-center ${textClassName}`}
      style={{ backgroundColor: person.color, color: textOn(person.color) }}
    >
      {initials(person.name)}
    </span>
  )
}
