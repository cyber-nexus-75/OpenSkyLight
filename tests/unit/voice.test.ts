import { describe, expect, it } from 'vitest'
import { parseVoiceCommand } from '../../src/shared/groceries/voice'
import { normalizeItemName, parseSpokenItem } from '../../src/shared/groceries/normalize'

describe('parseVoiceCommand', () => {
  it('adds items to the order, with quantities', () => {
    expect(parseVoiceCommand('add milk')).toEqual({ type: 'addToList', item: 'milk', quantity: 1, unit: null })
    expect(parseVoiceCommand('add 2 gallons of milk to the list')).toEqual({
      type: 'addToList',
      item: 'milk',
      quantity: 2,
      unit: 'gallon'
    })
    expect(parseVoiceCommand('we need a dozen eggs for the week')).toEqual({
      type: 'addToList',
      item: 'eggs',
      quantity: 12,
      unit: 'dozen'
    })
    expect(parseVoiceCommand('please get bread')).toMatchObject({ type: 'addToList', item: 'bread' })
  })

  it('recognizes out-of-stock', () => {
    expect(parseVoiceCommand("we're out of eggs")).toEqual({ type: 'outOf', item: 'eggs' })
    expect(parseVoiceCommand('ran out of coffee')).toEqual({ type: 'outOf', item: 'coffee' })
  })

  it('recognizes usage and purchases', () => {
    expect(parseVoiceCommand('we used 2 eggs')).toEqual({ type: 'used', item: 'eggs', quantity: 2, unit: null })
    expect(parseVoiceCommand('we bought 3 lbs of chicken')).toEqual({
      type: 'bought',
      item: 'chicken',
      quantity: 3,
      unit: 'lb'
    })
    expect(parseVoiceCommand('add milk to the pantry')).toMatchObject({ type: 'bought', item: 'milk' })
  })

  it('recognizes queries and fry\'s handoff', () => {
    expect(parseVoiceCommand("what's low?")).toEqual({ type: 'lowStock' })
    expect(parseVoiceCommand('what are we running out of')).toEqual({ type: 'lowStock' })
    expect(parseVoiceCommand("what's in the pantry")).toEqual({ type: 'pantryQuery' })
    expect(parseVoiceCommand("what's on the list")).toEqual({ type: 'shoppingQuery' })
    expect(parseVoiceCommand("send the list to Fry's")).toEqual({ type: 'prepareFrys' })
    expect(parseVoiceCommand('add this week to kroger')).toEqual({ type: 'prepareFrys' })
  })

  it('recognizes list management and scanning', () => {
    expect(parseVoiceCommand('clear the shopping list')).toEqual({ type: 'clearList' })
    expect(parseVoiceCommand('scan the receipt')).toEqual({ type: 'scanReceipt' })
  })

  it('falls back to unknown', () => {
    expect(parseVoiceCommand('what time is it')).toEqual({ type: 'unknown', text: 'what time is it' })
    expect(parseVoiceCommand('')).toEqual({ type: 'unknown', text: '' })
  })
})

describe('normalize/quantity helpers', () => {
  it('normalizes names for matching', () => {
    expect(normalizeItemName('MILK 2% Whole!')).toBe('milk whole')
    expect(normalizeItemName('  Eggs,  Large ')).toBe('eggs large')
  })

  it('parses spoken quantities', () => {
    expect(parseSpokenItem('two pounds of flour')).toEqual({ quantity: 2, unit: 'lb', rest: 'flour' })
    expect(parseSpokenItem('salt')).toEqual({ quantity: 1, unit: null, rest: 'salt' })
  })
})
