<script setup>
import { ref } from "vue";

const count = ref(0);
</script>

<template>
  <main>
    <h1>Hello, Vue!</h1>
    <button @click="count++">count is {{ count }}</button>
    <p>Edit <code>src/App.vue</code> and save to reload.</p>
  </main>
</template>

<style scoped>
main {
  font-family: sans-serif;
  text-align: center;
  margin-top: 15vh;
}
</style>
