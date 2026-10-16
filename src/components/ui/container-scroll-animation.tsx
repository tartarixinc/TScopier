import { useEffect, useRef, useState, type ReactNode } from 'react'
import { motion, useScroll, useTransform, type MotionValue } from 'framer-motion'

/**
 * A tilted device frame that flattens and settles as the page scrolls.
 * The title block drifts up while the card rotates from 20deg to flat.
 */
export function ContainerScroll({
  titleComponent,
  children,
}: {
  titleComponent: ReactNode
  children: ReactNode
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const { scrollYProgress } = useScroll({
    target: containerRef,
    // 0 when the hero sits at the top of the page, 1 once its bottom reaches the viewport bottom.
    offset: ['start start', 'end end'],
  })
  const [isMobile, setIsMobile] = useState(false)

  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth <= 768)
    checkMobile()
    window.addEventListener('resize', checkMobile)
    return () => window.removeEventListener('resize', checkMobile)
  }, [])

  const rotate = useTransform(scrollYProgress, [0, 1], [20, 0])
  const scale = useTransform(scrollYProgress, [0, 1], isMobile ? [0.85, 1.95] : [0.95, 1.2])
  const translate = useTransform(scrollYProgress, [0, 1], [0, -90])

  return (
    <div
      ref={containerRef}
      className="relative flex h-[56rem] items-start justify-center px-2 md:h-[64rem] md:px-16"
    >
      <div className="relative w-full pb-10 pt-24 md:pt-28" style={{ perspective: '1000px' }}>
        <ScrollHeader translate={translate} titleComponent={titleComponent} />
        <ScrollCard rotate={rotate} scale={scale}>
          {children}
        </ScrollCard>
      </div>
    </div>
  )
}

function ScrollHeader({
  translate,
  titleComponent,
}: {
  translate: MotionValue<number>
  titleComponent: ReactNode
}) {
  return (
    <motion.div style={{ translateY: translate }} className="mx-auto max-w-5xl text-center">
      {titleComponent}
    </motion.div>
  )
}

function ScrollCard({
  rotate,
  scale,
  children,
}: {
  rotate: MotionValue<number>
  scale: MotionValue<number>
  children: ReactNode
}) {
  return (
    <motion.div
      style={{
        rotateX: rotate,
        scale,
        boxShadow:
          '0 0 #0000004d, 0 9px 20px #0000004a, 0 37px 37px #00000042, 0 84px 50px #00000026, 0 149px 60px #0000000a, 0 233px 65px #00000003',
      }}
      className="mx-auto mt-10 h-[30rem] w-full max-w-5xl rounded-[30px] border-4 border-[#6C6C6C] bg-[#222222] p-2 shadow-2xl md:mt-12 md:h-[40rem] md:p-6"
    >
      <div className="h-full w-full overflow-hidden rounded-2xl bg-gray-100 text-left md:p-0 dark:bg-zinc-900">
        {children}
      </div>
    </motion.div>
  )
}
