import { useEffect } from 'react'

export function ReactGrabBootstrap() {
  useEffect(() => {
    if (!import.meta.env.DEV) {
      return
    }

    let isCancelled = false

    void import('react-grab')
      .then(({ getGlobalApi }) => {
        if (isCancelled) {
          return
        }

        getGlobalApi()?.setOptions({
          allowActivationInsideInput: false,
        })
      })
      .catch((error: unknown) => {
        console.error('Failed to load react-grab.', error)
      })

    return () => {
      isCancelled = true
    }
  }, [])

  return null
}
