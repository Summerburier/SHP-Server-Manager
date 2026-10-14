<script setup>
import {notify} from '../notifications.js';
import {ref} from 'vue';import {requestJson} from '../api.js';
const emit=defineEmits(['done']);const pin=ref(''),username=ref('admin'),password=ref(''),repeat=ref(''),busy=ref(false),error=ref('');
async function submit(){busy.value=true;error.value='';try{if(password.value!==repeat.value)throw new Error('两次密码不一致');await requestJson('/api/setup',{method:'POST',body:JSON.stringify({pin:pin.value,username:username.value,password:password.value})});notify('管理员账户已创建');emit('done');}catch(e){notify(e.message,'error');}finally{busy.value=false;}}
</script>
<template><section class="login login-setup"><form class="login-console" @submit.prevent="submit"><h1>初始化卫戍中枢</h1><p>创建管理员账户，随后在服务管理中接入服务。</p><label>首次配置验证码<input v-model="pin" required autocomplete="off" placeholder="后台启动终端显示的验证码"></label><label>用户名<input v-model="username" required pattern="[a-zA-Z0-9_.@-]{1,64}" autocomplete="username"></label><label>密码<input v-model="password" type="password" required minlength="8" maxlength="512" autocomplete="new-password"></label><label>确认密码<input v-model="repeat" type="password" required minlength="8" autocomplete="new-password"></label><button :disabled="busy">{{ busy?'创建中…':'创建管理员账户' }}</button></form></section></template>
