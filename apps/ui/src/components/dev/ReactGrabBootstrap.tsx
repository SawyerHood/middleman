import { useEffect } from 'react'

const shouldEnableReactGrab =
  import.meta.env.DEV || import.meta.env.VITE_MINIFY === 'false'

export function ReactGrabBootstrap() {
  if (!shouldEnableReactGrab) {
    return null
  }

  return <EnabledReactGrabBootstrap />
}

function EnabledReactGrabBootstrap() {
  useEffect(() => {
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
