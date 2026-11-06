import { describe, expect, it } from 'vitest'
import { profilePhotoObjectPath, validateProfilePhoto, validateProfilePhotoSource } from './profilePhoto'

describe('validateProfilePhoto', () => {
  it('accepts a jpeg under the size limit', () => {
    expect(validateProfilePhoto({ type: 'image/jpeg', size: 1200 })).toBeNull()
  })

  it('rejects an unsupported type', () => {
    expect(validateProfilePhoto({ type: 'image/gif', size: 1200 })).toBe('type')
  })

  it('rejects a file over 2 MB', () => {
    expect(validateProfilePhoto({ type: 'image/png', size: 2 * 1024 * 1024 + 1 })).toBe('size')
  })

  it('accepts a larger original before cropping', () => {
    expect(validateProfilePhotoSource({ type: 'image/jpeg', size: 8 * 1024 * 1024 })).toBeNull()
    expect(validateProfilePhotoSource({ type: 'image/jpeg', size: 12 * 1024 * 1024 + 1 })).toBe('size')
  })
})

describe('profilePhotoObjectPath', () => {
  it('keeps the file inside the user folder', () => {
    expect(profilePhotoObjectPath('user-1')).toBe('user-1/avatar')
  })
})
