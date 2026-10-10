import { describe, expect, it } from 'vitest'
import { profilePhotoCropFrame } from './profilePhotoCrop'

describe('profilePhotoCropFrame', () => {
  it('crops the center of a wide photo at the default zoom', () => {
    const frame = profilePhotoCropFrame({
      imageWidth: 2000,
      imageHeight: 1000,
      viewport: 280,
      zoom: 1,
      panX: 0,
      panY: 0,
    })
    expect(frame.sourceSize).toBeCloseTo(1000)
    expect(frame.sourceX).toBeCloseTo(500)
    expect(frame.sourceY).toBeCloseTo(0)
  })

  it('uses a smaller centered square when zoomed in', () => {
    const frame = profilePhotoCropFrame({
      imageWidth: 1000,
      imageHeight: 1000,
      viewport: 280,
      zoom: 2,
      panX: 0,
      panY: 0,
    })
    expect(frame.sourceSize).toBeCloseTo(500)
    expect(frame.sourceX).toBeCloseTo(250)
    expect(frame.sourceY).toBeCloseTo(250)
  })

  it('keeps the crop inside the photo when the drag goes past the edge', () => {
    const frame = profilePhotoCropFrame({
      imageWidth: 2000,
      imageHeight: 1000,
      viewport: 280,
      zoom: 1,
      panX: 5000,
      panY: 0,
    })
    expect(frame.sourceX).toBeCloseTo(0)
    expect(frame.sourceX + frame.sourceSize).toBeLessThanOrEqual(2000)
  })
})
