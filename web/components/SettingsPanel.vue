<script setup>
import {notify} from '../notifications.js';
import {ref,onMounted} from 'vue';
import {requestJson} from '../api.js';
const config=ref(null),adminUsername=ref(''),initialUsername=ref(''),currentPassword=ref(''),newPassword=ref(''),repeatPassword=ref(''),busy=ref(false),message=ref(''),failed=ref(false);
async function load(){try{const value=await requestJson('/api/settings');config.value=value.config;adminUsername.value=value.adminUsername;initialUsername.value=value.adminUsername;config.value.pluginsDirectory=value.pluginsDirectory;config.value.servers=config.value.servers.map(service=>{const copy={...service};if(!copy.source && copy.systemd){copy.source=copy.systemd.unit;copy.sudo=copy.systemd.sudo;delete copy.systemd;}if(!copy.source && copy.project){const {path,...options}=copy.project;copy.source=path;copy.projectOptions=options;delete copy.project;}return copy;});}catch(error){notify(error.status===404?'后端版本尚未更新，请重新启动后台。':error.message,'error');failed.value=true;}}
onMounted(load);
async function save(){busy.value=true;failed.value=false;message.value='';try{if(newPassword.value!==repeatPassword.value)throw new Error('两次新密码不一致');const servers=config.value.servers.map(service=>{const copy={...service};for(const key of ['source','url']){if(typeof copy[key]==='string')copy[key]=copy[key].trim();if(!copy[key])delete copy[key];}return copy;});const result=await requestJson('/api/settings',{method:'POST',body:JSON.stringify({config:{...config.value,servers},adminUsername:adminUsername.value,currentPassword:currentPassword.value,newPassword:newPassword.value})});currentPassword.value='';newPassword.value='';repeatPassword.value='';initialUsername.value=adminUsername.value;notify(result.message);}catch(error){failed.value=true;notify(error.message,'error');}finally{busy.value=false;}}
</script>
<template>
<form v-if="config" class="preferences" @submit.prevent="save">
<div class="preferences-general">
<section class="preference-section panel"><div class="preference-title"><span class="preference-number">01</span><h2>采样与同步</h2></div>
<div class="preference-line"><label for="sync-interval">服务同步间隔</label><div class="unit-input"><input id="sync-interval" v-model.number="config.pollIntervalSeconds" type="number" min="5" max="3600" required><span>秒</span></div></div>
<div class="preference-line"><label for="host-interval">性能采样间隔</label><div class="unit-input"><input id="host-interval" v-model.number="config.host.pollIntervalSeconds" type="number" min="2" max="60" required><span>秒</span></div></div>
<div class="preference-line"><label for="retention">历史保留时间</label><div class="unit-input"><input id="retention" v-model.number="config.retentionHours" type="number" min="1" max="168" required><span>小时</span></div></div></section>
<section class="preference-section panel"><div class="preference-title"><span class="preference-number">02</span><h2>插件存储</h2></div><label class="preference-field">插件目录<input v-model="config.pluginsDirectory" required placeholder="plugins"></label></section>
<section class="preference-section panel"><div class="preference-title"><span class="preference-number">03</span><h2>账户安全</h2><span class="preference-caption">管理员密码</span></div><label class="preference-field">用户名<input v-model="adminUsername" required maxlength="64" pattern="[a-zA-Z0-9_.@-]{1,64}" autocomplete="username"></label><label class="preference-field">当前密码<input v-model="currentPassword" type="password" autocomplete="current-password" :required="!!newPassword || adminUsername !== initialUsername" placeholder="修改账户时填写"></label><div class="preferences-pair"><label class="preference-field">新密码<input v-model="newPassword" type="password" autocomplete="new-password" minlength="8" maxlength="512" placeholder="至少 8 个字符"></label><label class="preference-field">确认新密码<input v-model="repeatPassword" type="password" autocomplete="new-password" :required="!!newPassword" placeholder="再次输入新密码"></label></div></section>
</div>
<div class="preference-savebar"><span v-if="!message">保存配置后重启后台生效，密码即时生效</span><button type="submit" :disabled="busy">{{ busy?'保存中…':'保存设置' }}</button></div>
</form><p v-else :class="failed?'danger':''">{{ message || '正在读取设置…' }}</p>
</template>
