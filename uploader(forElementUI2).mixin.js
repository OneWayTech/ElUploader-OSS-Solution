import urljoin from 'url-join'
import debounce from 'lodash/debounce'
import browserMD5File from 'browser-md5-file'
import addSeconds from 'date-fns/add_seconds'
const isStr = s => typeof s === 'string'

// 组件共享状态：OSS 上传签名
const oss = {
  dir: '', // 上传路径
  url: '', // 阿里云 OSS 地址
  expire: '', // 13 位毫秒数
  policy: '', // Base64 编码字符串
  signature: '', // 28 位字符串
  accessKeyId: '' // 16 位字符串
}

export default {
  props: {
    // 【注意】该项请使用 .sync 修饰，形式可为 'url' 或 ['url1', 'url2', ...]
    files: { type: [String, Array], required: true }
  },
  data: () => ({
    oss,
    key: '', // 正在上传的文件的 key（computed:access 依赖项）
    percent: 0, // 当前任务上传进度
    taskQueue: [], // 上传队列（基于 Promise 实现）
    isUploading: false,
    fileList: [] // 用于 ElUpload 组件的 $props.fileList
  }),
  computed: {
    action () { // 用于 ElUpload 组件的 $props.action
      return oss.url
    },
    access () { // 用于 ElUpload 组件的 $props.data
      return {
        key: this.key,
        policy: oss.policy,
        signature: oss.signature,
        OSSAccessKeyId: oss.accessKeyId,
        success_action_status: 200
      }
    }
  },
  watch: {
    files: {
      handler (files) {
        if (isStr(files)) {
          files = [files]
        }
        // 遵循 ElUpload 的 $props.fileList 的 [{ name, url }] 格式
        this.fileList = files.map((url, idx) => ({ name: '' + idx, url }))
      },
      immediate: true
    },
    isUploading (isUploading) {
      // isUploading 从 true 变成 false 时，在 nextTick 中同步 ElUpload $data.uploadFiles 到 $props.files
      // 为什么要 nextTick？因为 onSuccess 中执行 this.nextFile() 之后还有 file.url = uploadFile 的操作
      isUploading || this.$nextTick(() => {
        this.syncUploadFiles()
      })
    }
  },
  methods: {
    /**
     * 【注意：该方法须自行实现】新增上传任务，用于 ElUpload 组件的 before-upload 钩子函数，举例如下：
     * @param  {File}
     * @return {Boolean/Promise} - 官方文档写道：若返回 false 或者 Promise 则停止上传
      beforeUpload (file) {
        // 此处进行检测 file 合法性等操作，之后就只需要调用如下函数即可
        return this.addFile(file)
      }
     */
    syncUploadFiles () {
      // 这里最后意为排除掉 blob 开头的 URL（这算是一个坑），此时 files 有可能是空数组
      let files = this.$refs.upload.uploadFiles.map(({ url }) => url).filter(url => url.startsWith('http'))

      // 对于无论是否 multiple，ElUpload 的 $data.uploadFiles 始终都是数组类型
      // 因此若 $props.files 为字符串类型，则应取 files 的末位元素（注：空数组时取得 undefined）
      this.$emit('update:files', isStr(this.files) ? files.slice(-1)[0] || '' : files)
    },
    // 用于 ElUpload 的 on-progress
    onProgress ({ percent }) {
      this.percent = ~~percent
    },
    // 用于 ElUpload 的 on-success
    onSuccess (res, file, uploadFiles) {
      const uploadPath = this.nextFile()
      file.url = uploadPath // 把 blob 链接替换成 CDN 链接
    },
    // 用于 ElUpload 的 on-remove
    onRemove: debounce(function () {
      // 手动点击删除显然会调用本函数，但如下场景也会触发调用：
      // 限制 5 张，已传 3 张，若在文件管理器中再选 10 张上传
      // 则溢出了 8 张，即本函数将会频繁调用 8 次（所以要 debounce 一下）
      
      // 若本函数仅仅就是单纯执行 syncUploadFiles，则必然报错：
      // Uncaught TypeError: Cannot set property 'status' of null
      // 
      // 因为此时正在上传 2 张，ElUpload 内部的 handleProgress 一直在不断执行
      // 若直接就粗暴地调用 syncUploadFiles 则会触发 ElUpload $data.uploadFiles 的更新
      // 导致 handleProgress 中的 var file = this.getFile(rawFile) 为 null
      // 故随后 file.status = 'uploading' 就会立即报错
      // （详见源码 https://github.com/ElemeFE/element/blob/1.x/packages/upload/src/index.vue#L141-L146）
      this.isUploading
        ? setTimeout(() => this.onRemove, 1000)
        : this.syncUploadFiles()
    }, 250),
    // 用于 ElUpload 的 on-error（一般是 OSS access 过期了）
    onError () {
      this.isUploading = false // 重置上传状态很关键，否则之后就不能 auto run 了
      this.$message.warning('上传功能出了点问题，请重试')
    },
    addFile (file) {
      return new Promise(resolve => {
        this.taskQueue.push({ file, start: resolve })

        // auto run
        if (!this.isUploading) {
          this.isUploading = true
          this.nextFile(true)
        }
      })
    },
    nextFile (isAutorun) {
      // 当 isUploading false => true 时（auto run）：
      // 1. 若之前没有上传过的，则 this.action 和 this.key 均为 ''，故 join 出来是 '/'
      // 2. 若之前有上传过的，则结果为上一次的 uploadPath
      // 鉴于两者都没有意义，故由 auto run 触发的都无需执行 urljoin
      let uploadPath
      if (!isAutorun) {
        uploadPath = urljoin(this.action, this.key)
      }
      // 开发环境下打印出刚上传成功的文件链接以便调试
      // （为什么不写成 if(__DEV__ && !isAutorun)？因为有利于 UglifyJS 压缩时直接剔除整块代码 ）
      if (__DEV__) {
        if (!isAutorun) {
          console.info('上传成功：', uploadPath)
        }
      }

      const { taskQueue } = this
      if (taskQueue.length) {
        const ensureAccessValid = isAccessExpired() ? updateAccess : doNothing
        let nextTask
        ensureAccessValid().then(() => {
          nextTask = taskQueue.shift()
          return keygen(nextTask.file)
        }).then(key => {
          this.key = key // 更新 key 以更新 computed:access
          this.$nextTick(() => {
            nextTask.start() // 相当于 resolve 掉 before-upload 钩子中返回的 promise
          })
        }).catch(e => console.warn(e))
      } else {
        this.isUploading = false
      }
      
      return uploadPath
    }
  }
}

// 判断 access 是否过期（提前 10 秒过期）
function isAccessExpired () {
  return +addSeconds(new Date(), 10) > +oss.expire
}

/**
 * 更新 OSS access
 * @return {Promise}
 */
function updateAccess() {
  return <API>.then(re => {
    Object.assign(oss, re)
  })
}

function doNothing () {
  return Promise.resolve()
}

/**
 * 生成上传 key（基于文件哈希）
 * @param   {File}
 * @resolve {String} 形如 '<上传路径>/3d3e93a9745fd21240ef3c88045cc0d1.jpg'
 */
function keygen(file) {
  return new Promise((resolve, reject) => {
    browserMD5File(file, (err, md5) => {
      if (err) {
        reject(err)
        return
      }
      resolve(
        urljoin(oss.dir, `${md5}.${file.name.split('.').pop()}`)
      )
    })
  })
}
