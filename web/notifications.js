import {ref} from 'vue';
export const notices=ref([]);let nextId=0;const timers=new Map();
export function dismiss(id){clearTimeout(timers.get(id));timers.delete(id);notices.value=notices.value.filter(n=>n.id!==id);}
export function pause(id){clearTimeout(timers.get(id));timers.delete(id);}
export function resume(id){const notice=notices.value.find(n=>n.id===id);if(notice?.timeout)timers.set(id,setTimeout(()=>dismiss(id),notice.timeout));}
export function notify(text,type='success'){if(!text)return;const old=notices.value.find(n=>n.text===text&&n.type===type);if(old)return;while(notices.value.length>=5)dismiss(notices.value[0].id);const notice={id:++nextId,text,type,timeout:type==='error'?0:type==='warning'?8000:6000};notices.value.push(notice);resume(notice.id);}
