import type { ComputedRef, Ref } from 'vue-demi'
import type { EventHookOn, Fn, MaybeRef, Stoppable } from '@vueuse/shared'
import { containsProp, createEventHook, until, useTimeoutFn } from '@vueuse/shared'
import { computed, isRef, ref, shallowRef, unref, watch } from 'vue-demi'
import { defaultWindow } from '../_configurable'

export interface UseFetchReturn<T> {
  /**
   * Indicates if the fetch request has finished
   */
  isFinished: Ref<boolean>

  /**
   * The statusCode of the HTTP fetch response
   */
  statusCode: Ref<number | null>

  /**
   * The raw response of the fetch response
   */
  response: Ref<Response | null>

  /**
   * Any fetch errors that may have occurred
   */
  error: Ref<any>

  /**
   * The fetch response body, may either be JSON or text
   */
  data: Ref<T | null>

  /**
   * Indicates if the request is currently being fetched.
   */
  isFetching: Ref<boolean>

  /**
   * Indicates if the fetch request is able to be aborted
   */
  canAbort: ComputedRef<boolean>

  /**
   * Indicates if the fetch request was aborted
   */
  aborted: Ref<boolean>

  /**
   * Abort the fetch request
   */
  abort: Fn

  /**
   * Manually call the fetch
   * (default not throwing error)
   */
  execute: (throwOnFailed?: boolean) => Promise<any>

  /**
   * Fires after the fetch request has finished
   */
  onFetchResponse: EventHookOn<Response>

  /**
   * Fires after a fetch request error
   */
  onFetchError: EventHookOn

  /**
   * Fires after a fetch has completed
   */
  onFetchFinally: EventHookOn

  // methods
  get(): UseFetchReturn<T> & PromiseLike<UseFetchReturn<T>>
  post(payload?: MaybeRef<unknown>, type?: string): UseFetchReturn<T> & PromiseLike<UseFetchReturn<T>>
  put(payload?: MaybeRef<unknown>, type?: string): UseFetchReturn<T> & PromiseLike<UseFetchReturn<T>>
  delete(payload?: MaybeRef<unknown>, type?: string): UseFetchReturn<T> & PromiseLike<UseFetchReturn<T>>
  patch(payload?: MaybeRef<unknown>, type?: string): UseFetchReturn<T> & PromiseLike<UseFetchReturn<T>>
  head(payload?: MaybeRef<unknown>, type?: string): UseFetchReturn<T> & PromiseLike<UseFetchReturn<T>>
  options(payload?: MaybeRef<unknown>, type?: string): UseFetchReturn<T> & PromiseLike<UseFetchReturn<T>>

  // type
  json<JSON = any>(): UseFetchReturn<JSON> & PromiseLike<UseFetchReturn<JSON>>
  text(): UseFetchReturn<string> & PromiseLike<UseFetchReturn<string>>
  blob(): UseFetchReturn<Blob> & PromiseLike<UseFetchReturn<Blob>>
  arrayBuffer(): UseFetchReturn<ArrayBuffer> & PromiseLike<UseFetchReturn<ArrayBuffer>>
  formData(): UseFetchReturn<FormData> & PromiseLike<UseFetchReturn<FormData>>
}

type DataType = 'text' | 'json' | 'blob' | 'arrayBuffer' | 'formData'
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS'

const payloadMapping: Record<string, string> = {
  json: 'application/json',
  text: 'text/plain',
  formData: 'multipart/form-data',
}

export interface BeforeFetchContext {
  /**
   * The computed url of the current request
   */
  url: string

  /**
   * The request options of the current request
   */
  options: RequestInit

  /**
   * Cancels the current request
   */
  cancel: Fn
}

export interface AfterFetchContext<T = any> {
  response: Response

  data: T | null
}

export interface OnFetchErrorContext<T = any, E = any> {
  error: E

  data: T | null
}

export interface UseFetchOptions {
  /**
   * Fetch function
   */
  fetch?: typeof window.fetch

  /**
   * Will automatically run fetch when `useFetch` is used
   *
   * @default true
   */
  immediate?: boolean

  /**
   * Will automatically refetch when:
   * - the URL is changed if the URL is a ref
   * - the payload is changed if the payload is a ref
   *
   * @default false
   */
  refetch?: MaybeRef<boolean>

  /**
   * Initial data before the request finished
   *
   * @default null
   */
  initialData?: any

  /**
   * Timeout for abort request after number of millisecond
   * `0` means use browser default
   *
   * @default 0
   */
  timeout?: number

  /**
   * Will run immediately before the fetch request is dispatched
   */
  beforeFetch?: (ctx: BeforeFetchContext) => Promise<Partial<BeforeFetchContext> | void> | Partial<BeforeFetchContext> | void

  /**
   * Will run immediately after the fetch request is returned.
   * Runs after any 2xx response
   */
  afterFetch?: (ctx: AfterFetchContext) => Promise<Partial<AfterFetchContext>> | Partial<AfterFetchContext>

  /**
   * Will run immediately after the fetch request is returned.
   * Runs after any 4xx and 5xx response
   */
  onFetchError?: (ctx: { data: any; response: Response | null; error: any }) => Promise<Partial<OnFetchErrorContext>> | Partial<OnFetchErrorContext>
}

export interface CreateFetchOptions {
  /**
   * The base URL that will be prefixed to all urls
   */
  baseUrl?: MaybeRef<string>

  /**
   * Default Options for the useFetch function
   */
  options?: UseFetchOptions

  /**
   * Options for the fetch request
   */
  fetchOptions?: RequestInit
}

/**
 * !!!IMPORTANT!!!
 *
 * If you update the UseFetchOptions interface, be sure to update this object
 * to include the new options
 */
function isFetchOptions(obj: object): obj is UseFetchOptions {
  // 只要obj中存在'immediate', 'refetch', 'initialData', 'timeout', 'beforeFetch', 'afterFetch', 'onFetchError', 'fetch'中的任意一个，这些都是usefetch中特有的配置
  return containsProp(obj, 'immediate', 'refetch', 'initialData', 'timeout', 'beforeFetch', 'afterFetch', 'onFetchError', 'fetch')
}

function headersToObject(headers: HeadersInit | undefined) {
  if (headers instanceof Headers)
    return Object.fromEntries([...headers.entries()])

  return headers
}

// 构建自己的fetch对象
export function createFetch(config: CreateFetchOptions = {}) {
  const _options = config.options || {}
  const _fetchOptions = config.fetchOptions || {}

  function useFactoryFetch(url: MaybeRef<string>, ...args: any[]) {

    // 拼接 baseUrl 路径
    const computedUrl = computed(() => config.baseUrl
      ? joinPaths(unref(config.baseUrl), unref(url))
      : unref(url),
    )

    let options = _options
    let fetchOptions = _fetchOptions

    // Merge properties into a single object
    if (args.length > 0) {
      if (isFetchOptions(args[0])) {
        options = { ...options, ...args[0] }
      }
      else {
        fetchOptions = {
          ...fetchOptions,
          ...args[0],
          headers: {
            ...(headersToObject(fetchOptions.headers) || {}),
            ...(headersToObject(args[0].headers) || {}),
          },
        }
      }
    }

    if (args.length > 1 && isFetchOptions(args[1]))
      options = { ...options, ...args[1] }

    return useFetch(computedUrl, fetchOptions, options)
  }

  return useFactoryFetch as typeof useFetch
}

export function useFetch<T>(url: MaybeRef<string>): UseFetchReturn<T> & PromiseLike<UseFetchReturn<T>>
export function useFetch<T>(url: MaybeRef<string>, useFetchOptions: UseFetchOptions): UseFetchReturn<T> & PromiseLike<UseFetchReturn<T>>
export function useFetch<T>(url: MaybeRef<string>, options: RequestInit, useFetchOptions?: UseFetchOptions): UseFetchReturn<T> & PromiseLike<UseFetchReturn<T>>

export function useFetch<T>(url: MaybeRef<string>, ...args: any[]): UseFetchReturn<T> & PromiseLike<UseFetchReturn<T>> {

  // 判断windown有没有中止请求的方法
  const supportsAbort = typeof AbortController === 'function'

  //  fetchOptions原生配置，同Request对象
  let fetchOptions: RequestInit = {}

  // usefetch插件的配置，默认 immediate：调用函数就发送请求，如果设置为false，调用函数不会发送请求，需要从函数返回值中获取execute方法，在合适的时候去调用
  // refetch：如果设置为true，url发生变化时，会重新执行一次请求（一般极少会这样用吧）
  //  timeout：设置请求超时时间为0，也就是和浏览器保持一致
  let options: UseFetchOptions = { immediate: true, refetch: false, timeout: 0 }


  interface InternalConfig { method: HttpMethod; type: DataType; payload: unknown; payloadType?: string }

  // 这个对象？？？
  const config: InternalConfig = {
    method: 'GET',
    type: 'text' as DataType,
    payload: undefined as unknown,
  }


  // 此处获取传入参数的配置对应是usefetch还是fetch的配置
  // 如果函数参数超过2，判断第二个参数是否为 给 useFetch的配置，如果是，合并传入的配置到默认options中，如果不是给useFetch的，那就是 原生fetch的配置
  if (args.length > 0) {
    if (isFetchOptions(args[0]))
      options = { ...options, ...args[0] }
    else
      fetchOptions = args[0]
  }

  // 如果函数入参超过三个，判断第三个参数是否为usefetch的配置，如果是，继续合并到options，所以理论上，参数二和参数三都可以传usefetch配置项，最终会合并到一起
  if (args.length > 1) {
    if (isFetchOptions(args[1]))
      options = { ...options, ...args[1] }
  }


  const {
    fetch = defaultWindow?.fetch, // 默认使用window对象的fetch，此处defaultWindow做了ssr判断，只有在客户端才会有值
    initialData,
    timeout, // 请求最长时间
  } = options


  // 注册事件
  const responseEvent = createEventHook<Response>() // 得到请求响应体
  const errorEvent = createEventHook<any>() // 请求错误
  const finallyEvent = createEventHook<any>() // 请求结束


  // 是否完成请求，与isFetching互斥
  const isFinished = ref(false)

  // 是否正在请求中，与isFinished互斥
  const isFetching = ref(false)

   // 是否取消了请求
  const aborted = ref(false)


  // 请求得到的状态码
  const statusCode = ref<number | null>(null)


  // 请求响应
  const response = shallowRef<Response | null>(null)


  // 请求的错误信息
  const error = shallowRef<any>(null)

  // 请求得到的data
  const data = shallowRef<T | null>(initialData)

  // 请求是否可以被中止：只有浏览器支持 AbortController 并且请求还未完成时，才可被中止
  const canAbort = computed(() => supportsAbort && isFetching.value)

  // 中止控制器
  let controller: AbortController | undefined
  let timer: Stoppable | undefined


  // 中止请求的方法：浏览器支持并存在请求中止控制器
  const abort = () => {
    if (supportsAbort && controller)
      controller.abort()
  }

  // 控制请求状态
  const loading = (isLoading: boolean) => {
    isFetching.value = isLoading
    isFinished.value = !isLoading
  }

  // 如果配置了请求最长时间，则初始化计时器，到达最长时间后中止主动请求（这里只是得到一个计数器，并没有启动计时器，启动在execute函数中发送请求前）
  if (timeout)
    timer = useTimeoutFn(abort, timeout, { immediate: false })


  // 手动发起请求
  const execute = async (throwOnFailed = false) => {
    // 设置状态为加载中
    loading(true)

    // 初始化状态
    error.value = null
    statusCode.value = null
    aborted.value = false
    controller = undefined


    // 如果浏览器支持取消请求，则构建AbortController对象示例，在取消成功的钩子中将 aborted 设置为true
    if (supportsAbort) {
      controller = new AbortController()
      controller.signal.onabort = () => aborted.value = true

      // controller设置到fetch请求中
      fetchOptions = {
        ...fetchOptions,
        signal: controller.signal,
      }
    }

    // 默认的fetch配置
    const defaultFetchOptions: RequestInit = {
      method: config.method,
      headers: {},
    }

    // 如果配置中有传参数，处理headers请求头：如果你指定了传参的数据类型，则设置正确的 Content-Type，如果传参是json格式，转成json字符串
    if (config.payload) {
      // headersToObject：如果headers是一个普通Object，不处理；如果headers是一个Headers实例化对象，则复制一份
      const headers = headersToObject(defaultFetchOptions.headers) as Record<string, string>

      // 如果传递了传参格式，得到对应正确的Content-Type，只支持 json/text/formData 格式
      if (config.payloadType)
        headers['Content-Type'] = payloadMapping[config.payloadType] ?? config.payloadType

      // 如果传参是json格式，转成json字符串
      defaultFetchOptions.body = config.payloadType === 'json' ? JSON.stringify(unref(config.payload)) : unref(config.payload) as BodyInit
    }

    // 初始化取消状态
    let isCanceled = false

    // 初始化 beforeFetch 钩子中的 上下文对象， beforeFetch 钩子中的 options 配置的是fetch请求时的配置
    const context: BeforeFetchContext = { url: unref(url), options: { ...defaultFetchOptions, ...fetchOptions }, cancel: () => { isCanceled = true } }

    // 如果 配置中存在 beforeFetch，等待 beforeFetch 执行结束，beforeFetch 可以是异步操作，把 beforeFetch 修改过的 options
    if (options.beforeFetch)
      Object.assign(context, await options.beforeFetch(context))

    // 如果 beforeFetch 生命周期中调用了 cancel 方法，或者 fetch不存在（浏览器不支持或者传入的fetch对象为错误），设置请求状态为false，并 resolve(null)
    if (isCanceled || !fetch) {
      loading(false)
      return Promise.resolve(null)
    }

    // 初始化响应体body内容，这个是格式化过的数据
    let responseData: any = null

    // 开始计时
    if (timer)
      timer.start()

    return new Promise<Response | null>((resolve, reject) => {
      fetch(
        context.url,
        {
          ...defaultFetchOptions,
          ...context.options,
          headers: {
            ...headersToObject(defaultFetchOptions.headers),
            ...headersToObject(context.options?.headers),
          },
        },
      )
        .then(async (fetchResponse) => {

          // 得到响应体
          response.value = fetchResponse
          statusCode.value = fetchResponse.status

          // 转换响应格式
          responseData = await fetchResponse[config.type]()

          // 如果配置了 afterFetch，且响应的状态码在 200 - 300区间，等待 afterFetch 钩子执行，afterFetch可以异步
          if (options.afterFetch && statusCode.value >= 200 && statusCode.value < 300)
            ({ data: responseData } = await options.afterFetch({ data: responseData, response: fetchResponse }))


          data.value = responseData

          // see: https://www.tjvantoll.com/2015/09/13/fetch-and-errors/
          // 请求的状态是否ok
          if (!fetchResponse.ok)
            throw new Error(fetchResponse.statusText)

          // 触发 onFetchResponse  事件
          responseEvent.trigger(fetchResponse)
          return resolve(fetchResponse)
        })
        .catch(async (fetchError) => {

          // 得到错误信息
          let errorData = fetchError.message || fetchError.name

          // 如果配置了 onFetchError ，等待onFetchError执行完毕
          if (options.onFetchError)
            ({ data: responseData, error: errorData } = await options.onFetchError({ data: responseData, error: fetchError, response: response.value }))
          data.value = responseData
          error.value = errorData

          // 触发 onFetchError 生命周期
          errorEvent.trigger(fetchError)

          //  请求失败是否reject抛出异常
          if (throwOnFailed)
            return reject(fetchError)

          return resolve(null)
        })
        .finally(() => {
          // 关闭状态、停止计时器、触发 onFetchFinally 事件
          loading(false)
          if (timer)
            timer.stop()
          finallyEvent.trigger(null)
        })
    })
  }

  // 监听参数url和配置refetch，如果url变化了，且refetch为true，只发送请求
  watch(
    () => [
      unref(url),
      unref(options.refetch),
    ],
    () => unref(options.refetch) && execute(),
    { deep: true },
  )

  const shell: UseFetchReturn<T> = {
    isFinished,
    statusCode,
    response,
    error,
    data,
    isFetching,
    canAbort,
    aborted,
    abort,
    execute,

    onFetchResponse: responseEvent.on,
    onFetchError: errorEvent.on,
    onFetchFinally: finallyEvent.on,
    // method
    get: setMethod('GET'),
    put: setMethod('PUT'),
    post: setMethod('POST'),
    delete: setMethod('DELETE'),
    patch: setMethod('PATCH'),
    head: setMethod('HEAD'),
    options: setMethod('OPTIONS'),
    // type
    json: setType('json'),
    text: setType('text'),
    blob: setType('blob'),
    arrayBuffer: setType('arrayBuffer'),
    formData: setType('formData'),
  }

  // 设置请求方式
  function setMethod(method: HttpMethod) {
    return (payload?: unknown, payloadType?: string) => {
      if (!isFetching.value) {
        config.method = method
        config.payload = payload
        config.payloadType = payloadType

        // 监听参数和 refetch，如果参数改变，且 options.refetch = true，就会重新发送请求
        if (isRef(config.payload)) {
          watch(
            () => [
              unref(config.payload),
              unref(options.refetch),
            ],
            () => unref(options.refetch) && execute(),
            { deep: true },
          )
        }

        // Set the payload to json type only if it's not provided and a literal object is provided
        // The only case we can deduce the content type and `fetch` can't

        // 如果没有设置请求参数的类型，并且传参是个Object，则主动设置为 json格式
        if (!payloadType && unref(payload) && Object.getPrototypeOf(unref(payload)) === Object.prototype)
          config.payloadType = 'json'

        // 返回和请求函数一致的内容
        return {
          ...shell,
          then(onFulfilled: any, onRejected: any) {
            return waitUntilFinished()
              .then(onFulfilled, onRejected)
          },
        } as any
      }
      return undefined
    }
  }

  function waitUntilFinished() {
    return new Promise<UseFetchReturn<T>>((resolve, reject) => {
      // 观察者模式，等待 isFinished 完成后将 shell资源resolve出去
      until(isFinished).toBe(true)
        .then(() => resolve(shell))
        .catch(error => reject(error))
    })
  }

  // 设置响应数据类型，在请求前后才会被成功设置，
  function setType(type: DataType) {
    return () => {
      if (!isFetching.value) {
        config.type = type
        return {
          ...shell,
          then(onFulfilled: any, onRejected: any) {
            return waitUntilFinished()
              .then(onFulfilled, onRejected)
          },
        } as any
      }
      return undefined
    }
  }

  // immediate默认为true，默认调用函数就发送请求
  if (options.immediate)
    setTimeout(execute, 0)

  return {
    ...shell, // 解构了多种资源
    then(onFulfilled, onRejected) { // useFetch方法的then
      return waitUntilFinished()
        .then(onFulfilled, onRejected)
    },
  }
}

function joinPaths(start: string, end: string): string {
  if (!start.endsWith('/') && !end.startsWith('/'))
    return `${start}/${end}`

  return `${start}${end}`
}
